import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  AFFILIATE_ERROR_CODES,
  DENY_CONDITIONS_MAX,
  OFFER_NAME_MAX_LENGTH,
  OFFER_URL_MAX_LENGTH,
  REWARD_YEN_MAX,
  assertPeriod,
  normalizeCreateOffer,
  normalizeOfferUrl,
  normalizeUpdateOffer,
  type CreateOfferInput,
} from '@/modules/affiliate';

/** 案件の入力検証（TASKS D-1、SPEC 5.8） */

function input(overrides: Partial<CreateOfferInput> = {}): CreateOfferInput {
  return {
    name: 'サンプル案件',
    aspName: 'サンプルASP',
    landingPageUrl: 'https://lp.example.com/offer',
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    conversionType: 'FREE_SIGNUP',
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

describe('normalizeCreateOffer', () => {
  it('既定値を埋める', () => {
    const result = normalizeCreateOffer(input());

    expect(result).toMatchObject({
      advertiserName: null,
      rewardYen: null,
      userExperience: 'UNKNOWN',
      userRating: null,
      denyConditions: [],
      // **既定は DRAFT。** 登録した瞬間に記事へ出さない
      status: 'DRAFT',
      facts: {},
    });
  });

  it('前後の空白を落とす', () => {
    expect(normalizeCreateOffer(input({ name: '  案件  ' })).name).toBe('案件');
  });

  it.each([
    ['案件名が空', { name: '   ' }],
    ['ASP名が空', { aspName: '' }],
    ['案件名が長すぎる', { name: 'あ'.repeat(OFFER_NAME_MAX_LENGTH + 1) }],
  ])('拒否する（%s）', (_label, overrides) => {
    expect(codeOf(() => normalizeCreateOffer(input(overrides)))).toBe(
      AFFILIATE_ERROR_CODES.invalidOffer,
    );
  });

  it.each([
    [
      '成果地点',
      { conversionType: 'NOPE' as CreateOfferInput['conversionType'] },
    ],
    [
      '利用経験',
      { userExperience: 'NOPE' as CreateOfferInput['userExperience'] },
    ],
    ['状態', { status: 'NOPE' as CreateOfferInput['status'] }],
  ])('知らない %s の値を拒否する', (_label, overrides) => {
    expect(codeOf(() => normalizeCreateOffer(input(overrides)))).toBe(
      AFFILIATE_ERROR_CODES.invalidOffer,
    );
  });

  it.each([[-1], [1.5], [REWARD_YEN_MAX + 1]])(
    '報酬額 %s を拒否する',
    (rewardYen) => {
      expect(codeOf(() => normalizeCreateOffer(input({ rewardYen })))).toBe(
        AFFILIATE_ERROR_CODES.invalidOffer,
      );
    },
  );

  it.each([[0], [1], [REWARD_YEN_MAX]])('報酬額 %s を通す', (rewardYen) => {
    expect(normalizeCreateOffer(input({ rewardYen })).rewardYen).toBe(
      rewardYen,
    );
  });

  it.each([[0], [6], [2.5]])('評価 %s を拒否する', (userRating) => {
    expect(codeOf(() => normalizeCreateOffer(input({ userRating })))).toBe(
      AFFILIATE_ERROR_CODES.invalidOffer,
    );
  });

  it('NG条件の件数を制限する', () => {
    const denyConditions = Array.from(
      { length: DENY_CONDITIONS_MAX + 1 },
      (_, index) => `条件${index}`,
    );

    expect(codeOf(() => normalizeCreateOffer(input({ denyConditions })))).toBe(
      AFFILIATE_ERROR_CODES.invalidOffer,
    );
  });
});

describe('normalizeOfferUrl', () => {
  it.each([
    ['https://lp.example.com/a'],
    ['http://lp.example.com/a'],
    ['https://lp.example.com/a?b=c#d'],
  ])('%s を通す', (value) => {
    expect(() => normalizeOfferUrl(value, 'LPのURL')).not.toThrow();
  });

  /**
   * **記事本文へ埋める値。** `javascript:` を通すと読者のブラウザで
   * 任意のスクリプトが動く。
   */
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['ftp://example.com/a'],
    ['file:///etc/passwd'],
  ])('%s を拒否する', (value) => {
    expect(codeOf(() => normalizeOfferUrl(value, 'LPのURL'))).toBe(
      AFFILIATE_ERROR_CODES.invalidUrl,
    );
  });

  it('認証情報付きのURLを拒否する', () => {
    expect(
      codeOf(() => normalizeOfferUrl('https://u:p@example.com/a', 'LPのURL')),
    ).toBe(AFFILIATE_ERROR_CODES.invalidUrl);
  });

  it.each([[''], ['   '], ['これはURLではない']])('%o を拒否する', (value) => {
    expect(codeOf(() => normalizeOfferUrl(value, 'LPのURL'))).toBe(
      AFFILIATE_ERROR_CODES.invalidUrl,
    );
  });

  it('長すぎるURLを拒否する', () => {
    const long = `https://example.com/${'a'.repeat(OFFER_URL_MAX_LENGTH)}`;

    expect(codeOf(() => normalizeOfferUrl(long, 'LPのURL'))).toBe(
      AFFILIATE_ERROR_CODES.invalidUrl,
    );
  });

  // どの項目が悪いかを伝えないと直しようがない
  it('項目名をメッセージに含める', () => {
    try {
      normalizeOfferUrl('nope', 'アフィリエイトURL');
    } catch (error) {
      expect((error as AppError).message).toContain('アフィリエイトURL');
    }
  });
});

describe('assertPeriod', () => {
  const start = new Date('2026-08-01T00:00:00Z');

  it('終了が開始より後なら通す', () => {
    expect(() =>
      assertPeriod(start, new Date('2026-08-02T00:00:00Z')),
    ).not.toThrow();
  });

  /**
   * 逆になっていると案件が一度も選ばれず、原因が
   * 「選定ロジックの不具合」に見える（F-2）。
   */
  it.each([['2026-07-31T00:00:00Z'], ['2026-08-01T00:00:00Z']])(
    '終了が %s なら拒否する',
    (value) => {
      expect(codeOf(() => assertPeriod(start, new Date(value)))).toBe(
        AFFILIATE_ERROR_CODES.invalidPeriod,
      );
    },
  );

  it.each([
    [null, null],
    [start, null],
    [null, start],
  ])('片方が無ければ確かめない（%o, %o）', (from, to) => {
    expect(() => assertPeriod(from, to)).not.toThrow();
  });
});

describe('normalizeUpdateOffer', () => {
  // `undefined` は「変えない」（B-3 の updateBlogForUser と同じ扱い）
  it('渡された項目だけを返す', () => {
    expect(normalizeUpdateOffer({ name: '新しい名前' })).toEqual({
      name: '新しい名前',
    });
  });

  it('何も渡さなければ空を返す', () => {
    expect(normalizeUpdateOffer({})).toEqual({});
  });

  it('null で消せる項目がある', () => {
    expect(normalizeUpdateOffer({ advertiserName: null })).toEqual({
      advertiserName: null,
    });
    expect(normalizeUpdateOffer({ rewardYen: null })).toEqual({
      rewardYen: null,
    });
  });

  it('URLを検証する', () => {
    expect(
      codeOf(() =>
        normalizeUpdateOffer({ affiliateUrl: 'javascript:alert(1)' }),
      ),
    ).toBe(AFFILIATE_ERROR_CODES.invalidUrl);
  });

  /**
   * **`link_mode` と `sub_id_param` は受け取らない**（Q-001・Q-014）。
   * どちらもASPの規約に関わる判断で、モニターに判断させない。
   */
  it('link_mode や sub_id_param を渡しても無視する', () => {
    const data = normalizeUpdateOffer({
      linkMode: 'REDIRECT',
      subIdParam: 'sub',
      name: '名前',
    } as Parameters<typeof normalizeUpdateOffer>[0]);

    expect(data).toEqual({ name: '名前' });
  });
});
