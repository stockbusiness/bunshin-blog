import { describe, expect, it, vi } from 'vitest';
import {
  applyMapping,
  decodeCsvBytes,
  parseCsv,
  readConversionType,
  readRewardYen,
  readStatus,
  sanitizeMapping,
  suggestColumnMapping,
  toScorableShape,
} from '@/modules/affiliate';
import { findExclusion } from '@/modules/content-planning';
import type { AiProvider } from '@/lib/ai';

/**
 * ASPのCSVから案件の候補を作る（Q-056）。
 *
 * ここで守りたいのは1つ。**列がずれたまま取り込まない。**
 * ずれると**報酬額の欄に案件名が入り**、足切り（SPEC 9.2.3）が
 * 意味を失う。数千件をまとめて入れるので、**気づかないまま広がる。**
 */

function providerReturning(text: string): AiProvider {
  return {
    complete: vi.fn(async () => ({
      text,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      provider: 'test',
      model: 'test',
    })),
  } as unknown as AiProvider;
}

describe('文字コードを読む', () => {
  /** **日本のASPはたいてい Shift_JIS** */
  it('Shift_JIS を読む', () => {
    // 「月額用」
    const bytes = Uint8Array.from([0x8c, 0x8e, 0x8a, 0x7a, 0x97, 0x70, 0x0a]);

    expect(decodeCsvBytes(bytes).trim()).toBe('月額用');
  });

  it('UTF-8 を読む', () => {
    const bytes = new TextEncoder().encode('案件名,報酬\n');

    expect(decodeCsvBytes(bytes).trim()).toBe('案件名,報酬');
  });

  /** **BOM を見出しに混ぜない。** 混ざると列の対応づけが外れる */
  it('BOM付きUTF-8 の BOM を落とす', () => {
    const body = new TextEncoder().encode('案件名,報酬\n');
    const bytes = new Uint8Array(body.byteLength + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);

    expect(decodeCsvBytes(bytes).startsWith('案件名')).toBe(true);
  });
});

/**
 * **囲みの中の改行とカンマを壊さない。** 単純に `split(',')` すると
 * 列がずれ、**報酬額の欄に案件名が入る。**
 */
describe('CSVを行と列に分ける', () => {
  it('見出しと行に分ける', () => {
    const table = parseCsv('案件名,報酬\nA,1480\nB,980\n');

    expect(table.headers).toEqual(['案件名', '報酬']);
    expect(table.rows).toEqual([
      ['A', '1480'],
      ['B', '980'],
    ]);
  });

  it('囲みの中のカンマを壊さない', () => {
    const table = parseCsv('案件名,報酬\n"A社, B事業部",1480\n');

    expect(table.rows[0]).toEqual(['A社, B事業部', '1480']);
  });

  it('囲みの中の改行を壊さない', () => {
    const table = parseCsv('案件名,否認\n"A","二重申込\n他社経由"\n');

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]).toBe('二重申込\n他社経由');
  });

  it('囲みの中の二重引用符を読む', () => {
    const table = parseCsv('案件名\n"""特典""つき"\n');

    expect(table.rows[0]?.[0]).toBe('"特典"つき');
  });

  it('CRLF を LF と同じに扱う', () => {
    const table = parseCsv('案件名,報酬\r\nA,1480\r\n');

    expect(table.rows).toEqual([['A', '1480']]);
  });

  /** **末尾の改行で1行増やさない** */
  it('末尾の空行を落とす', () => {
    const table = parseCsv('案件名\nA\n\n');

    expect(table.rows).toEqual([['A']]);
  });

  it('中身が無ければ断る', () => {
    expect(() => parseCsv('')).toThrow(/中身がありません/);
  });
});

describe('列の対応づけ', () => {
  it('AIが返した番号を使う', async () => {
    const table = parseCsv(
      'プログラム名,成果報酬,リンク先\nA,1480,https://e.test/\n',
    );

    const mapping = await suggestColumnMapping(table, {
      provider: providerReturning(
        '{"name":0,"rewardYen":1,"landingPageUrl":2}',
      ),
    });

    expect(mapping).toEqual({ name: 0, rewardYen: 1, landingPageUrl: 2 });
  });

  it('コードフェンス付きでも読む', async () => {
    const table = parseCsv('名前\nA\n');

    const mapping = await suggestColumnMapping(table, {
      provider: providerReturning('```json\n{"name":0}\n```'),
    });

    expect(mapping).toEqual({ name: 0 });
  });

  /** **応答本文を例外へ載せない**（SPEC 14.2） */
  it('読めなければ手で選ぶよう案内する', async () => {
    const table = parseCsv('名前\nA\n');

    await expect(
      suggestColumnMapping(table, {
        provider: providerReturning('秘密のような何か'),
      }),
    ).rejects.toThrow(/手で選んで/);
  });
});

/** **AIの答えをそのまま信じない。** 間違っても画面で直せる */
describe('AIの答えを削る', () => {
  it('知らない項目を落とす', () => {
    expect(sanitizeMapping({ name: 0, しらない項目: 1 }, 3)).toEqual({
      name: 0,
    });
  });

  it('範囲の外の列番号を落とす', () => {
    expect(sanitizeMapping({ name: 0, rewardYen: 9 }, 3)).toEqual({ name: 0 });
  });

  it('負の列番号を落とす', () => {
    expect(sanitizeMapping({ name: -1 }, 3)).toEqual({});
  });
});

/**
 * **推測で足切りを効かせない。** 分からないものを `FREE_SIGNUP` に
 * すると、報酬800円未満の足切り（SPEC 9.2.3）が誤って効く。
 */
describe('成果条件を読む', () => {
  it.each([
    ['無料会員登録', 'FREE_SIGNUP'],
    ['資料請求', 'REQUEST'],
    ['無料体験の申し込み', 'FREE_SIGNUP'],
    ['お試しセット', 'TRIAL'],
    ['商品購入', 'PURCHASE'],
    ['', 'OTHER'],
    ['よく分からない条件', 'OTHER'],
  ])('%s → %s', (input, expected) => {
    expect(readConversionType(input)).toBe(expected);
  });
});

/**
 * **金額でないものを金額として扱わない。** 扱うと足切りが意味を失う。
 */
describe('報酬額を読む', () => {
  it.each([
    ['1,480円', 1480],
    ['¥1,480', 1480],
    ['1480', 1480],
    ['', null],
    ['—', null],
  ])('%s → %s', (input, expected) => {
    expect(readRewardYen(input)).toBe(expected);
  });

  /** **割合は金額ではない。** 10% を 10円として足切りに掛けない */
  it('割合は読まない', () => {
    expect(readRewardYen('売上の10%')).toBeNull();
    expect(readRewardYen('10％')).toBeNull();
  });
});

/**
 * **分からないものを ENDED にしない。** すると使える案件が黙って消える。
 */
describe('提携の状態を読む', () => {
  it.each([
    ['提携中', 'ACTIVE'],
    ['', 'ACTIVE'],
    ['よく分からない', 'ACTIVE'],
    ['掲載終了', 'ENDED'],
    ['提携解除', 'ENDED'],
    ['一時停止', 'PAUSED'],
  ])('%s → %s', (input, expected) => {
    expect(readStatus(input)).toBe(expected);
  });
});

describe('行を候補へ写す', () => {
  const table = parseCsv(
    [
      'プログラム名,成果報酬,リンク先,状態,否認条件',
      'A社サービス,"1,480円",https://a.example.com/,提携中,"二重申込・他社経由"',
      ',980円,https://b.example.com/,提携中,',
      'C社,500円,ただの文字列,提携中,',
    ].join('\n'),
  );

  const mapping = {
    name: 0,
    rewardYen: 1,
    landingPageUrl: 2,
    status: 3,
    denyConditions: 4,
  };

  it('値を写す', () => {
    const candidates = applyMapping(table, mapping);

    expect(candidates[0]).toMatchObject({
      rowNumber: 1,
      name: 'A社サービス',
      rewardYen: 1480,
      landingPageUrl: 'https://a.example.com/',
      status: 'ACTIVE',
      denyConditions: ['二重申込', '他社経由'],
      problem: null,
    });
  });

  /** **使えない行を黙って落とさない。** 何が足りないかを画面へ出す */
  it('名前が空なら理由を付ける', () => {
    expect(applyMapping(table, mapping)[1]?.problem).toBe('案件の名前が空です');
  });

  it('URLとして読めなければ理由を付ける', () => {
    expect(applyMapping(table, mapping)[2]?.problem).toMatch(/URLとして/);
  });

  it('選ばなかった列は空のまま', () => {
    const candidates = applyMapping(table, { name: 0, landingPageUrl: 2 });

    expect(candidates[0]?.rewardYen).toBeNull();
    expect(candidates[0]?.advertiserName).toBeNull();
  });
});

/**
 * **足切りは `content-planning` の判定をそのまま使う**（正しさを2か所に
 * 持たない）。`lp_not_evaluated` は**「落ちた」ではなく
 * 「CSVの範囲では通った」**という印。
 */
describe('足切りに掛けられる形になる', () => {
  function candidate(overrides: Record<string, unknown> = {}) {
    const table = parseCsv(
      'name,reward,url\nA社,3000円,https://a.example.com/\n',
    );
    const [first] = applyMapping(table, {
      name: 0,
      rewardYen: 1,
      landingPageUrl: 2,
    });

    return { ...first, ...overrides } as ReturnType<typeof applyMapping>[0];
  }

  it('CSVの範囲で通ったものは lp_not_evaluated になる', () => {
    const shape = toScorableShape(
      candidate({ conversionType: 'PURCHASE', rewardYen: 5_000 }),
    );

    expect(findExclusion(shape)).toBe('lp_not_evaluated');
  });

  it('購入型で報酬が足りなければ落ちる', () => {
    const shape = toScorableShape(
      candidate({ conversionType: 'PURCHASE', rewardYen: 2_999 }),
    );

    expect(findExclusion(shape)).toBe('low_reward_purchase');
  });

  it('無料登録型で報酬が足りなければ落ちる', () => {
    const shape = toScorableShape(
      candidate({ conversionType: 'FREE_SIGNUP', rewardYen: 799 }),
    );

    expect(findExclusion(shape)).toBe('low_reward_free_signup');
  });

  it('終了したものは落ちる', () => {
    expect(findExclusion(toScorableShape(candidate({ status: 'ENDED' })))).toBe(
      'ended',
    );
  });

  it('否認条件が3つ以上なら落ちる', () => {
    const shape = toScorableShape(
      candidate({ denyConditions: ['あ', 'い', 'う'] }),
    );

    expect(findExclusion(shape)).toBe('many_deny_conditions');
  });

  /** **CSVからは掲載禁止を判断しない**（ASPの規約の判断・Q-019） */
  it('掲載禁止は CSV から決めない', () => {
    expect(toScorableShape(candidate()).blogPostingProhibited).toBe(false);
  });
});
