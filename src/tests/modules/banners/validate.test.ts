import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  BANNER_ERROR_CODES,
  BANNER_NAME_MAX_LENGTH,
  TARGET_CATEGORIES_MAX,
  assertBannerPeriod,
  normalizeCreateBanner,
  normalizeDestinationUrl,
  normalizeImageUrl,
  normalizeTargetCategories,
  normalizeUpdateBanner,
  type CreateBannerInput,
} from '@/modules/banners';

/**
 * バナーの入力検証（TASKS D-3、SPEC 5.9）。
 *
 * 完了条件は「**表示位置・対象カテゴリ・有効期間が保存される**」。
 */

function input(overrides: Partial<CreateBannerInput> = {}): CreateBannerInput {
  return {
    name: 'サンプルバナー',
    imageUrl: 'https://cdn.example.com/banner.png',
    destinationUrl: 'https://asp.example/click?a=xxxx',
    slot: 'TOP',
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('normalizeCreateBanner', () => {
  it('既定値を埋める', () => {
    expect(normalizeCreateBanner(input())).toMatchObject({
      targetCategories: [],
      // 登録したら出す。案件（DRAFT 既定）と違い、バナーは出すために作る
      status: 'ACTIVE',
      startsAt: null,
      endsAt: null,
    });
  });

  it.each([
    ['TOP'],
    ['AFTER_FIRST_HEADING'],
    ['MIDDLE'],
    ['BOTTOM'],
    ['SIDEBAR'],
  ])('表示位置 %s を保存する', (slot) => {
    expect(
      normalizeCreateBanner(input({ slot: slot as CreateBannerInput['slot'] }))
        .slot,
    ).toBe(slot);
  });

  it('知らない表示位置を拒否する', () => {
    expect(
      codeOf(() =>
        normalizeCreateBanner(
          input({ slot: 'FOOTER' as CreateBannerInput['slot'] }),
        ),
      ),
    ).toBe(BANNER_ERROR_CODES.invalidBanner);
  });

  it('知らない状態を拒否する', () => {
    expect(
      codeOf(() =>
        normalizeCreateBanner(
          input({ status: 'NOPE' as CreateBannerInput['status'] }),
        ),
      ),
    ).toBe(BANNER_ERROR_CODES.invalidBanner);
  });

  it.each([
    ['バナー名が空', { name: '  ' }],
    ['バナー名が長すぎる', { name: 'あ'.repeat(BANNER_NAME_MAX_LENGTH + 1) }],
  ])('拒否する（%s）', (_label, overrides) => {
    expect(codeOf(() => normalizeCreateBanner(input(overrides)))).toBe(
      BANNER_ERROR_CODES.invalidBanner,
    );
  });
});

describe('normalizeImageUrl', () => {
  it('https を通す', () => {
    expect(normalizeImageUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
  });

  /**
   * **バナーはモニターのブログ（https）に `<img>` として埋まる。**
   * `http` の画像は混在コンテンツとして遮断され、
   * **表示されないまま気づかれない。**
   */
  it('http を拒否する', () => {
    expect(
      codeOf(() => normalizeImageUrl('http://cdn.example.com/a.png')),
    ).toBe(BANNER_ERROR_CODES.invalidUrl);
  });

  it.each([['javascript:alert(1)'], ['data:image/png;base64,AAAA'], ['   ']])(
    '%o を拒否する',
    (value) => {
      expect(codeOf(() => normalizeImageUrl(value))).toBe(
        BANNER_ERROR_CODES.invalidUrl,
      );
    },
  );

  // 理由が分からないと直しようがない
  it('httpsを求める理由をメッセージに含める', () => {
    try {
      normalizeImageUrl('http://cdn.example.com/a.png');
    } catch (error) {
      expect((error as AppError).message).toContain('https');
    }
  });
});

describe('normalizeDestinationUrl', () => {
  /**
   * **遷移先はこちらでは選べない**（ASPや広告主のURL）。
   * 画像と違い、混在コンテンツにはならない。
   */
  it.each([['https://asp.example/click'], ['http://asp.example/click']])(
    '%s を通す',
    (value) => {
      expect(() => normalizeDestinationUrl(value)).not.toThrow();
    },
  );

  it.each([['javascript:alert(1)'], ['data:text/html,x'], ['ftp://a/b']])(
    '%s を拒否する',
    (value) => {
      expect(codeOf(() => normalizeDestinationUrl(value))).toBe(
        BANNER_ERROR_CODES.invalidUrl,
      );
    },
  );

  it('認証情報付きのURLを拒否する', () => {
    expect(
      codeOf(() => normalizeDestinationUrl('https://u:p@a.example/b')),
    ).toBe(BANNER_ERROR_CODES.invalidUrl);
  });
});

describe('normalizeTargetCategories', () => {
  it('未指定なら空（全ての記事が対象）', () => {
    expect(normalizeTargetCategories(undefined)).toEqual([]);
  });

  it('前後の空白を落とす', () => {
    expect(normalizeTargetCategories(['  美容  ', '健康'])).toEqual([
      '美容',
      '健康',
    ]);
  });

  // 同じカテゴリが2つ入っていても意味が無い
  it('重複を落とす', () => {
    expect(normalizeTargetCategories(['美容', '美容', '健康'])).toEqual([
      '美容',
      '健康',
    ]);
  });

  it('空文字を拒否する', () => {
    expect(codeOf(() => normalizeTargetCategories(['美容', ' ']))).toBe(
      BANNER_ERROR_CODES.invalidBanner,
    );
  });

  it('件数を制限する', () => {
    const values = Array.from(
      { length: TARGET_CATEGORIES_MAX + 1 },
      (_, index) => `カテゴリ${index}`,
    );

    expect(codeOf(() => normalizeTargetCategories(values))).toBe(
      BANNER_ERROR_CODES.invalidBanner,
    );
  });
});

describe('assertBannerPeriod', () => {
  const start = new Date('2026-08-01T00:00:00Z');

  it('終了が開始より後なら通す', () => {
    expect(() =>
      assertBannerPeriod(start, new Date('2026-08-02T00:00:00Z')),
    ).not.toThrow();
  });

  /**
   * 逆になっているバナーは一度も表示されず、原因が
   * 「表示ロジックの不具合」に見える。
   */
  it.each([['2026-07-31T00:00:00Z'], ['2026-08-01T00:00:00Z']])(
    '終了が %s なら拒否する',
    (value) => {
      expect(codeOf(() => assertBannerPeriod(start, new Date(value)))).toBe(
        BANNER_ERROR_CODES.invalidPeriod,
      );
    },
  );

  it('片方が無ければ確かめない', () => {
    expect(() => assertBannerPeriod(start, null)).not.toThrow();
    expect(() => assertBannerPeriod(null, start)).not.toThrow();
  });
});

describe('normalizeUpdateBanner', () => {
  it('渡された項目だけを返す', () => {
    expect(normalizeUpdateBanner({ slot: 'BOTTOM' })).toEqual({
      slot: 'BOTTOM',
    });
  });

  it('何も渡さなければ空を返す', () => {
    expect(normalizeUpdateBanner({})).toEqual({});
  });

  it('URLを検証する', () => {
    expect(
      codeOf(() =>
        normalizeUpdateBanner({ imageUrl: 'http://a.example/b.png' }),
      ),
    ).toBe(BANNER_ERROR_CODES.invalidUrl);
  });

  /**
   * **所有権の確認が要るため、ここでは扱わない**（`repository.ts` の担当）。
   * 素通しすると他ブログの案件を紐づけられる。
   */
  it('affiliateOfferId をここでは扱わない', () => {
    expect(normalizeUpdateBanner({ affiliateOfferId: 'offer-1' })).toEqual({});
  });
});
