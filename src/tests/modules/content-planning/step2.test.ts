import { describe, expect, it } from 'vitest';
import {
  ADOPTION_LIMIT,
  ADOPTION_MIN_SCORE,
  EXCLUSION_REASONS,
  SCORE_MAX,
  adoptOffers,
  findExclusion,
  scoreOffer,
  unevaluatedOffers,
  type ScorableOffer,
  type SearchDemand,
} from '@/modules/content-planning';

/**
 * STEP 2 の足切りとスコア（TASKS E-5、SPEC 9.2.3）。
 *
 * 完了条件「**足切り・100点満点スコア・上位3件採用がコードで判定される**」。
 *
 * **AIから受け取るのは検索需要の3値だけ**で、点数への写像はコード側の
 * 定数（CONTENT_PLANNING 3.2）。この関数はAIを呼ばない。
 */

let sequence = 0;

/** 何にも引っかからない案件（LP評価済み） */
function offer(overrides: Partial<ScorableOffer> = {}): ScorableOffer {
  sequence += 1;

  return {
    id: `offer-${String(sequence).padStart(3, '0')}`,
    name: 'テスト案件',
    advertiserName: 'テスト広告主',
    conversionType: 'FREE_SIGNUP',
    rewardYen: 1_000,
    denyConditions: [],
    userExperience: 'USED',
    lpFormFields: 4,
    lpMobileReady: true,
    lpEvaluatedAt: new Date('2026-08-01T00:00:00Z'),
    blogPostingProhibited: false,
    status: 'ACTIVE',
    ...overrides,
  };
}

describe('足切り（SPEC 9.2.3）', () => {
  it('何も無ければ通る', () => {
    expect(findExclusion(offer())).toBeNull();
  });

  it.each([
    ['ENDED', EXCLUSION_REASONS.ended],
    ['PAUSED', EXCLUSION_REASONS.paused],
  ])('%s は除外', (status, reason) => {
    expect(findExclusion(offer({ status }))).toBe(reason);
  });

  it('購入型で報酬3,000円未満は除外', () => {
    expect(
      findExclusion(offer({ conversionType: 'PURCHASE', rewardYen: 2_999 })),
    ).toBe(EXCLUSION_REASONS.lowRewardPurchase);
    expect(
      findExclusion(offer({ conversionType: 'PURCHASE', rewardYen: 3_000 })),
    ).toBeNull();
  });

  it('無料登録型で報酬800円未満は除外', () => {
    expect(
      findExclusion(offer({ conversionType: 'FREE_SIGNUP', rewardYen: 799 })),
    ).toBe(EXCLUSION_REASONS.lowRewardFreeSignup);
    expect(
      findExclusion(offer({ conversionType: 'FREE_SIGNUP', rewardYen: 800 })),
    ).toBeNull();
  });

  /** 報酬が未入力なら0円として扱う（低いほうへ倒す） */
  it('報酬が未入力なら足切りされる', () => {
    expect(findExclusion(offer({ rewardYen: null }))).toBe(
      EXCLUSION_REASONS.lowRewardFreeSignup,
    );
  });

  it('否認条件が3つ以上は除外', () => {
    expect(findExclusion(offer({ denyConditions: ['a', 'b'] }))).toBeNull();
    expect(findExclusion(offer({ denyConditions: ['a', 'b', 'c'] }))).toBe(
      EXCLUSION_REASONS.manyDenyConditions,
    );
  });

  /** **`false` のときだけ落とす。** `null` は「非対応」ではなく「未評価」 */
  it('スマートフォン非対応は除外。未評価とは分ける', () => {
    expect(findExclusion(offer({ lpMobileReady: false }))).toBe(
      EXCLUSION_REASONS.lpNotMobileReady,
    );
    expect(
      findExclusion(offer({ lpMobileReady: null, lpEvaluatedAt: null })),
    ).toBe(EXCLUSION_REASONS.lpNotEvaluated);
  });

  /** Q-019。文言ではなくフラグで判定する */
  it('ブログ掲載禁止は除外', () => {
    expect(findExclusion(offer({ blogPostingProhibited: true }))).toBe(
      EXCLUSION_REASONS.blogPostingProhibited,
    );
  });

  /**
   * **未評価を最後に見る。** 他の理由で落ちる案件をわざわざ
   * 「未評価」として ADMIN に見せない。
   */
  it('ほかの理由で落ちる案件は未評価として出さない', () => {
    expect(findExclusion(offer({ status: 'ENDED', lpEvaluatedAt: null }))).toBe(
      EXCLUSION_REASONS.ended,
    );
  });
});

describe('スコア（100点満点）', () => {
  function total(
    overrides: Partial<ScorableOffer>,
    demand: SearchDemand = 'NONE',
  ): number {
    return scoreOffer(offer(overrides), demand).breakdown.total;
  }

  it('満点は100点', () => {
    const result = scoreOffer(
      offer({
        conversionType: 'FREE_SIGNUP',
        rewardYen: 10_000,
        lpFormFields: 5,
        userExperience: 'USED',
        denyConditions: [],
      }),
      'HIGH',
    );

    expect(result.breakdown).toMatchObject({
      conversionPoint: 30,
      reward: 20,
      lpQuality: 20,
      searchDemand: 15,
      experience: 10,
      denyConditions: 5,
      total: SCORE_MAX,
    });
  });

  it.each([
    ['FREE_SIGNUP', 30],
    ['REQUEST', 20],
    ['TRIAL', 15],
    ['PURCHASE', 10],
  ] as const)('成果地点 %s は %s点', (conversionType, expected) => {
    expect(
      scoreOffer(offer({ conversionType, rewardYen: 10_000 }), 'NONE').breakdown
        .conversionPoint,
    ).toBe(expected);
  });

  it.each([
    [10_000, 20],
    [5_000, 15],
    [3_000, 10],
    [1_000, 5],
    [999, 0],
  ])('報酬%s円は%s点', (rewardYen, expected) => {
    expect(scoreOffer(offer({ rewardYen }), 'NONE').breakdown.reward).toBe(
      expected,
    );
  });

  it.each([
    [5, 20],
    [6, 10],
    [10, 10],
    [11, 0],
  ])('フォーム項目%s個は%s点', (lpFormFields, expected) => {
    expect(
      scoreOffer(offer({ lpFormFields }), 'NONE').breakdown.lpQuality,
    ).toBe(expected);
  });

  /** **写像はコード側の定数**（CONTENT_PLANNING 3.2） */
  it.each([
    ['HIGH', 15],
    ['MEDIUM', 8],
    ['NONE', 0],
  ] as const)('検索需要 %s は %s点', (demand, expected) => {
    expect(scoreOffer(offer(), demand).breakdown.searchDemand).toBe(expected);
  });

  it.each([
    ['USED', 10],
    ['UNKNOWN', 3],
    ['NOT_USED', 0],
  ] as const)('利用経験 %s は %s点', (userExperience, expected) => {
    expect(
      scoreOffer(offer({ userExperience }), 'NONE').breakdown.experience,
    ).toBe(expected);
  });

  it.each([
    [0, 5],
    [1, 3],
    [2, 1],
  ])('否認条件%s件は%s点', (count, expected) => {
    expect(
      scoreOffer(offer({ denyConditions: Array(count).fill('x') }), 'NONE')
        .breakdown.denyConditions,
    ).toBe(expected);
  });

  /**
   * **未評価は0点ではなく足切り。** 0点として採点すると、LPが良い案件が
   * 「LPの質0点」で沈み、落選の理由が「測っていない」から
   * 「質が低い」に化ける。
   */
  it('未評価の案件は足切りされる', () => {
    const result = scoreOffer(
      offer({ lpFormFields: null, lpMobileReady: null, lpEvaluatedAt: null }),
      'HIGH',
    );

    expect(result.eligible).toBe(false);
    expect(result.breakdown.excludedBy).toBe(EXCLUSION_REASONS.lpNotEvaluated);
  });

  /** **足切りされた案件も内訳を残す**（落ちた理由を後から確かめる） */
  it('足切りされても内訳は残る', () => {
    const result = scoreOffer(offer({ status: 'ENDED' }), 'HIGH');

    expect(result.eligible).toBe(false);
    expect(result.breakdown.total).toBeGreaterThan(0);
    expect(result.breakdown.excludedBy).toBe(EXCLUSION_REASONS.ended);
  });

  it('合計は内訳の和と一致する', () => {
    const { breakdown } = scoreOffer(offer({ rewardYen: 5_000 }), 'MEDIUM');

    expect(breakdown.total).toBe(
      breakdown.conversionPoint +
        breakdown.reward +
        breakdown.lpQuality +
        breakdown.searchDemand +
        breakdown.experience +
        breakdown.denyConditions,
    );
    expect(total({ rewardYen: 5_000 }, 'MEDIUM')).toBe(breakdown.total);
  });
});

describe('採用（60点以上の上位3件）', () => {
  function scoredWith(totals: number[]) {
    // 報酬で点数を作る。60点の境目をまたぐ組み合わせを用意する
    return totals.map((target, index) =>
      scoreOffer(
        offer({
          id: `offer-${index}`,
          conversionType: target >= 60 ? 'FREE_SIGNUP' : 'PURCHASE',
          rewardYen: target >= 60 ? 10_000 : 3_000,
          lpFormFields: target >= 60 ? 5 : 11,
          userExperience: target >= 60 ? 'USED' : 'NOT_USED',
        }),
        'NONE',
      ),
    );
  }

  it('60点未満は採用しない', () => {
    const scored = scoredWith([80, 30]);

    expect(scored[0]?.breakdown.total).toBeGreaterThanOrEqual(
      ADOPTION_MIN_SCORE,
    );
    expect(scored[1]?.breakdown.total).toBeLessThan(ADOPTION_MIN_SCORE);
    expect(adoptOffers(scored)).toHaveLength(1);
  });

  it('上位3件まで', () => {
    expect(adoptOffers(scoredWith([80, 80, 80, 80, 80]))).toHaveLength(
      ADOPTION_LIMIT,
    );
  });

  /** **足切りされた案件は点数に関わらず採用しない** */
  it('足切りされた案件は高得点でも採用しない', () => {
    const scored = [
      scoreOffer(
        offer({ id: 'a', rewardYen: 10_000, status: 'ENDED' }),
        'HIGH',
      ),
      scoreOffer(offer({ id: 'b', rewardYen: 10_000 }), 'HIGH'),
    ];

    expect(adoptOffers(scored).map((entry) => entry.offerId)).toEqual(['b']);
  });

  it('点数の高い順に並ぶ', () => {
    const scored = [
      scoreOffer(offer({ id: 'low', rewardYen: 1_000 }), 'NONE'),
      scoreOffer(offer({ id: 'high', rewardYen: 10_000 }), 'HIGH'),
    ];

    expect(adoptOffers(scored)[0]?.offerId).toBe('high');
  });

  /** **同点でも呼ぶたびに入れ替わらない。** 再実行で構成表が変わる */
  it('同点の並びは毎回同じ', () => {
    const scored = [
      scoreOffer(offer({ id: 'zzz', rewardYen: 10_000 }), 'HIGH'),
      scoreOffer(offer({ id: 'aaa', rewardYen: 10_000 }), 'HIGH'),
    ];

    expect(adoptOffers(scored).map((entry) => entry.offerId)).toEqual([
      'aaa',
      'zzz',
    ]);
    expect(adoptOffers([...scored].reverse()).map((e) => e.offerId)).toEqual([
      'aaa',
      'zzz',
    ]);
  });

  it('0件なら空を返す', () => {
    expect(adoptOffers(scoredWith([30, 30]))).toEqual([]);
  });
});

describe('未評価の集計', () => {
  /** 「点が足りなかった」と「まだ測っていない」は対応が違う */
  it('未評価だけを数える', () => {
    const scored = [
      scoreOffer(offer({ id: 'a', lpEvaluatedAt: null }), 'NONE'),
      scoreOffer(offer({ id: 'b', status: 'ENDED' }), 'NONE'),
      scoreOffer(offer({ id: 'c' }), 'NONE'),
    ];

    expect(unevaluatedOffers(scored).map((entry) => entry.offerId)).toEqual([
      'a',
    ]);
  });
});
