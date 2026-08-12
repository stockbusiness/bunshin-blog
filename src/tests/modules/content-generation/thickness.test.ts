import { describe, expect, it } from 'vitest';
import {
  MIN_BODY_CHARS,
  MIN_HEADINGS,
  countBodyChars,
  countHeadings,
  judgeThickness,
  type ThicknessInput,
} from '@/modules/content-generation';

/**
 * 記事の厚みの判定（TASKS J-4）。
 *
 * **事実チェック（E-12）は嘘を止め、禁止表現の検査（E-13）は
 * 言ってはいけないことを止める。「薄い」を止めるものが無かった。**
 *
 * **すべて `warning`。** 止めると、作り直す経路が無いので
 * **記事は二度と出られない。**
 */

/** 厚い記事（どの判定にも引っかからない） */
function thick(overrides: Partial<ThicknessInput> = {}): ThicknessInput {
  return {
    bodyHtml: `<h2>あ</h2><p>${'本'.repeat(MIN_BODY_CHARS)}</p><h2>い</h2><h3>う</h3>`,
    usedFactIds: ['fact-1'],
    hasOffer: true,
    plannedOutboundLinks: 1,
    actualInternalLinks: 1,
    ...overrides,
  };
}

function codes(input: ThicknessInput): string[] {
  return judgeThickness(input).map((flag) => flag.code);
}

describe('数える', () => {
  it('タグを除いて数える', () => {
    expect(countBodyChars('<p>あいう</p>')).toBe(3);
  });

  it('空白と実体参照を数えない', () => {
    expect(countBodyChars('<p>あ い&nbsp;う</p>')).toBe(3);
  });

  it('h2 と h3 を数える', () => {
    expect(countHeadings('<h2>あ</h2><h3>い</h3><h4>う</h4>')).toBe(2);
  });
});

describe('厚い記事には何も出ない', () => {
  it('フラグが立たない', () => {
    expect(judgeThickness(thick())).toEqual([]);
  });
});

describe('薄さを見つける', () => {
  it('本文が短ければ知らせる', () => {
    expect(
      codes(
        thick({ bodyHtml: '<h2>あ</h2><h2>い</h2><h3>う</h3><p>短い</p>' }),
      ),
    ).toContain('THIN_BODY');
  });

  it('何字だったかを文面に入れる', () => {
    const flag = judgeThickness(thick({ bodyHtml: '<p>あいう</p>' })).find(
      (item) => item.code === 'THIN_BODY',
    );

    // **足りないことだけでなく、どれだけ足りないかを出す**
    expect(flag?.message).toContain('3字');
  });

  it(`見出しが${MIN_HEADINGS}つ未満なら知らせる`, () => {
    expect(
      codes(
        thick({ bodyHtml: `<h2>あ</h2><p>${'本'.repeat(MIN_BODY_CHARS)}</p>` }),
      ),
    ).toContain('FEW_HEADINGS');
  });

  /**
   * **`used_fact_ids` は保存しているのに、誰も読んでいなかった。**
   * 事実を1つも使わない記事は、その案件について何も具体的なことを
   * 言っていない
   */
  it('案件の事実を使っていなければ知らせる', () => {
    expect(codes(thick({ usedFactIds: [] }))).toContain('NO_FACT_USED');
  });

  /** **案件の無い記事に「事実を使っていない」と言わない**（使う相手がいない） */
  it('案件が無ければ言わない', () => {
    expect(codes(thick({ usedFactIds: [], hasOffer: false }))).not.toContain(
      'NO_FACT_USED',
    );
  });

  /** **原因を1つに決めつけない**（案件に事実が無い場合もある） */
  it('案件側の可能性も文面に残す', () => {
    const flag = judgeThickness(thick({ usedFactIds: [] })).find(
      (item) => item.code === 'NO_FACT_USED',
    );

    expect(flag?.message).toContain('登録されていない可能性');
  });

  it('誘導先があるのにリンクが無ければ知らせる', () => {
    expect(codes(thick({ actualInternalLinks: 0 }))).toContain(
      'NO_INTERNAL_LINK',
    );
  });

  /** 収益記事には誘導先が無い（自分が誘導先） */
  it('誘導先が定められていなければ言わない', () => {
    expect(
      codes(thick({ plannedOutboundLinks: 0, actualInternalLinks: 0 })),
    ).not.toContain('NO_INTERNAL_LINK');
  });
});

/**
 * **止めると、記事は二度と出られない。** 作り直す経路がまだ無い
 * （`ARTICLE_REGENERATION` は種類があるだけで誰も積んでいない）
 */
describe('止めない', () => {
  it('すべて warning で返す', () => {
    const flags = judgeThickness({
      bodyHtml: '<p>短い</p>',
      usedFactIds: [],
      hasOffer: true,
      plannedOutboundLinks: 1,
      actualInternalLinks: 0,
    });

    expect(flags).toHaveLength(4);
    expect(flags.every((flag) => flag.severity === 'warning')).toBe(true);
  });
});
