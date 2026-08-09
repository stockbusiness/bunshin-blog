import { describe, expect, it } from 'vitest';
import {
  FACTS_STALE_DAYS,
  areFactsStale,
  checkAgainstFacts,
  extractNumbers,
  flattenFactStrings,
  isApprovable,
  judgeFactCheck,
  normalizeForMatch,
  verifyClaims,
  type ExtractedClaim,
} from '@/modules/content-generation';

/**
 * 事実チェックの判定（TASKS E-12、CONTENT_PLANNING 8.2、SPEC 9.7）。
 *
 * > 本文から事実主張を抽出させる**だけ**。**照合はコードで行う。**
 *
 * 完了条件は「facts外の数値・条件を検出。FAILEDは承認依頼へ送らない」。
 */

const OFFER_FACTS = {
  price: '月額500円',
  features: ['データ繰り越しができる', '解約金なし'],
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function claim(
  text: string,
  type: ExtractedClaim['type'] = 'PRICE',
): ExtractedClaim {
  return { text, type, excerpt: text };
}

describe('facts を照合用の文字列へ均す', () => {
  it('入れ子の葉をすべて取る', () => {
    expect(flattenFactStrings(OFFER_FACTS)).toEqual([
      '月額500円',
      'データ繰り越しができる',
      '解約金なし',
    ]);
  });

  /**
   * **`updatedAt` を外す。** 日付の数字が「facts にある数値」として
   * 数えられ、本文の無関係な数値を通してしまう
   */
  it('updatedAt は取らない', () => {
    expect(flattenFactStrings({ updatedAt: '2026-01-15' })).toEqual([]);
  });

  it('数値も文字列として取る', () => {
    expect(flattenFactStrings({ rewardYen: 3000 })).toEqual(['3000']);
  });

  it('facts が空でも落ちない', () => {
    expect(flattenFactStrings(null)).toEqual([]);
    expect(flattenFactStrings({})).toEqual([]);
  });
});

describe('数値の抜き出し', () => {
  it('桁区切りを外す', () => {
    expect(extractNumbers('初期費用は1,980円です')).toEqual(['1980']);
  });

  it('全角の数字も取る', () => {
    expect(extractNumbers('月額５００円')).toEqual(['500']);
  });

  it('複数の数値を全て取る', () => {
    expect(extractNumbers('月額500円、初期費用3000円')).toEqual([
      '500',
      '3000',
    ]);
  });

  it('数値が無ければ空', () => {
    expect(extractNumbers('解約金はかかりません')).toEqual([]);
  });
});

describe('正規化', () => {
  it('全角・大小・空白の揺れを吸収する', () => {
    expect(normalizeForMatch('月額 ５００円')).toBe(
      normalizeForMatch('月額500円'),
    );
  });
});

describe('facts との照合', () => {
  const factStrings = flattenFactStrings(OFFER_FACTS);

  it('facts の記述に触れていれば通る', () => {
    expect(
      checkAgainstFacts({ claimText: '月額500円で使えます', factStrings }),
    ).toBeNull();
  });

  /** **完了条件の「facts外の数値を検出」** */
  it('facts に無い数値が混ざれば落とす', () => {
    expect(
      checkAgainstFacts({
        claimText: '月額500円、初期費用は3,000円です',
        factStrings,
      }),
    ).toBe('NUMBER_NOT_IN_FACTS');
  });

  it('facts のどれにも触れていなければ落とす', () => {
    expect(
      checkAgainstFacts({ claimText: '初月は無料です', factStrings }),
    ).toBe('NOT_IN_FACTS');
  });

  it('照合先が空なら落とす', () => {
    expect(
      checkAgainstFacts({ claimText: '月額500円です', factStrings: [] }),
    ).toBe('NO_SOURCE');
  });

  /** 1文字の値は偶然当たる */
  it('1文字の facts を手がかりにしない', () => {
    expect(
      checkAgainstFacts({ claimText: 'Aプランです', factStrings: ['A'] }),
    ).toBe('NOT_IN_FACTS');
  });
});

describe('主張の照合先（CONTENT_PLANNING 8.2）', () => {
  it('PRICE / CONDITION / FEATURE は offer.facts を見る', () => {
    const unverified = verifyClaims({
      claims: [
        claim('月額500円です', 'PRICE'),
        claim('解約金なしで解約できます', 'CONDITION'),
        claim('データ繰り越しができるのが強みです', 'FEATURE'),
      ],
      offerFacts: OFFER_FACTS,
      usablePersonaFacts: [],
    });

    expect(unverified).toEqual([]);
  });

  /** **使ってよい事実だけを照合先にする。** D-6 の制限を無意味にしない */
  it('EXPERIENCE は persona_facts を見る', () => {
    const unverified = verifyClaims({
      claims: [claim('私も格安SIMへ乗り換えました', 'EXPERIENCE')],
      offerFacts: OFFER_FACTS,
      usablePersonaFacts: ['格安SIMへ乗り換えました'],
    });

    expect(unverified).toEqual([]);
  });

  it('EXPERIENCE は offer.facts では通らない', () => {
    const unverified = verifyClaims({
      claims: [claim('月額500円で使っています', 'EXPERIENCE')],
      offerFacts: OFFER_FACTS,
      usablePersonaFacts: [],
    });

    expect(unverified).toHaveLength(1);
    expect(unverified[0]?.reason).toBe('NO_SOURCE');
  });

  /**
   * **`GENERAL` に照合先は無い。** 一般論は保存された事実に紐づかない。
   * SPEC 9.7 の `WARNING`（「`GENERAL` のみ未確認」）が想定している状態
   */
  it('GENERAL は常に未確認', () => {
    const unverified = verifyClaims({
      claims: [claim('格安SIMは近年普及しています', 'GENERAL')],
      offerFacts: OFFER_FACTS,
      usablePersonaFacts: [],
    });

    expect(unverified).toHaveLength(1);
    expect(unverified[0]?.reason).toBe('NO_SOURCE');
  });

  it('未確認の主張だけを返す', () => {
    const unverified = verifyClaims({
      claims: [
        claim('月額500円です', 'PRICE'),
        claim('初期費用は3,000円です', 'PRICE'),
      ],
      offerFacts: OFFER_FACTS,
      usablePersonaFacts: [],
    });

    expect(unverified.map((entry) => entry.text)).toEqual([
      '初期費用は3,000円です',
    ]);
  });
});

describe('facts の古さ（CONTENT_PLANNING 8.2）', () => {
  const updatedAt = '2026-01-15T00:00:00.000Z';

  it('90日以内なら古くない', () => {
    expect(
      areFactsStale({
        facts: { updatedAt },
        now: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('90日を超えたら古い', () => {
    expect(
      areFactsStale({
        facts: { updatedAt },
        now: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  /**
   * **「いつ確かめたか分からない」を「新しい」に倒さない。**
   * 測っていないことが「問題なし」に化ける（Q-022）
   */
  it.each([
    { reason: 'updatedAt が無い', facts: {} },
    { reason: '日付として読めない', facts: { updatedAt: 'いつか' } },
    { reason: 'facts が無い', facts: null },
  ])('$reason なら古い扱い', ({ facts }) => {
    expect(areFactsStale({ facts, now: new Date() })).toBe(true);
  });

  it('ちょうど90日は古くない', () => {
    const now = new Date(
      new Date(updatedAt).getTime() + FACTS_STALE_DAYS * 24 * 60 * 60 * 1_000,
    );

    expect(areFactsStale({ facts: { updatedAt }, now })).toBe(false);
  });
});

describe('判定（SPEC 9.7）', () => {
  it('未確認が0件なら PASSED', () => {
    expect(judgeFactCheck({ unverified: [], factsAreStale: false })).toBe(
      'PASSED',
    );
  });

  it('GENERAL だけ未確認なら WARNING', () => {
    expect(
      judgeFactCheck({
        unverified: [{ ...claim('一般論', 'GENERAL'), reason: 'NO_SOURCE' }],
        factsAreStale: false,
      }),
    ).toBe('WARNING');
  });

  it.each(['PRICE', 'CONDITION', 'FEATURE', 'EXPERIENCE'] as const)(
    '%s に未確認があれば FAILED',
    (type) => {
      expect(
        judgeFactCheck({
          unverified: [{ ...claim('主張', type), reason: 'NOT_IN_FACTS' }],
          factsAreStale: false,
        }),
      ).toBe('FAILED');
    },
  );

  it('照合が一致しても facts が古ければ WARNING', () => {
    expect(judgeFactCheck({ unverified: [], factsAreStale: true })).toBe(
      'WARNING',
    );
  });

  /** **古い facts は FAILED を緩めない。** 引き上げるだけ */
  it('FAILED は古さで WARNING に下がらない', () => {
    expect(
      judgeFactCheck({
        unverified: [{ ...claim('主張', 'PRICE'), reason: 'NOT_IN_FACTS' }],
        factsAreStale: true,
      }),
    ).toBe('FAILED');
  });
});

describe('承認依頼へ送ってよいか（完了条件）', () => {
  it.each([
    ['PASSED', true],
    ['WARNING', true],
    ['FAILED', false],
    ['NOT_CHECKED', false],
  ] as const)('%s → %s', (status, expected) => {
    expect(isApprovable(status)).toBe(expected);
  });
});
