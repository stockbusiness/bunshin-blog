/**
 * STEP 2 案件スコアリングの判定（TASKS E-5、SPEC 9.2.3、CONTENT_PLANNING 3.1）。
 *
 * ## 足切りもスコアも全部コードで出す
 *
 * > 足切りとスコアの**全項目**をコードで計算する（CONTENT_PLANNING 3.1）
 *
 * AIから受け取るのは**検索需要の3値だけ**（`HIGH` / `MEDIUM` / `NONE`）で、
 * 点数への写像はここの定数。**AIに点数を返させない**（返させると、
 * プロンプト次第で合計が動く）。
 *
 * ## 未評価の案件は採点しない
 *
 * > `lpFormFields` と `lpMobileReady` は D-2 の自動評価結果を使う。
 * > **未評価の案件はスコアリング対象外**とし、ADMINに通知する
 * > （CONTENT_PLANNING 3.1）
 *
 * 未評価を0点として採点すると、**LPが良い案件が「LPの質0点」で沈む。**
 * 落選の理由が「評価していない」ではなく「質が低い」に化ける。
 *
 * DBも外部も触らない純粋な処理。
 */

/** 満点。内訳の合計と一致する（SPEC 9.2.3） */
export const SCORE_MAX = 100;

/** 採用の下限（SPEC 9.2.3「60点以上」） */
export const ADOPTION_MIN_SCORE = 60;

/** 採用する件数（SPEC 9.2.3「上位3件まで」） */
export const ADOPTION_LIMIT = 3;

export type ConversionType =
  'FREE_SIGNUP' | 'REQUEST' | 'TRIAL' | 'PURCHASE' | 'OTHER';

export type UserExperience = 'USED' | 'NOT_USED' | 'UNKNOWN';

/** AIに聞くのはこの3値だけ（CONTENT_PLANNING 3.2） */
export type SearchDemand = 'HIGH' | 'MEDIUM' | 'NONE';

/** 足切りの理由（SPEC 9.2.3） */
export const EXCLUSION_REASONS = {
  /** 掲載終了・提携終了 */
  ended: 'ended',
  /** 一時停止中 */
  paused: 'paused',
  /** 購入型で報酬3,000円未満 */
  lowRewardPurchase: 'low_reward_purchase',
  /** 無料登録型で報酬800円未満 */
  lowRewardFreeSignup: 'low_reward_free_signup',
  /** 否認条件が3つ以上 */
  manyDenyConditions: 'many_deny_conditions',
  /** LPがスマートフォン非対応 */
  lpNotMobileReady: 'lp_not_mobile_ready',
  /** ブログ掲載禁止（Q-019） */
  blogPostingProhibited: 'blog_posting_prohibited',
  /** LPが未評価。**落ちたのではなく、まだ測っていない** */
  lpNotEvaluated: 'lp_not_evaluated',
} as const;

export type ExclusionReason =
  (typeof EXCLUSION_REASONS)[keyof typeof EXCLUSION_REASONS];

/** スコアリングに要る案件の情報。**`affiliate` の型に依存しない** */
export interface ScorableOffer {
  id: string;
  name: string;
  advertiserName: string | null;
  conversionType: ConversionType;
  rewardYen: number | null;
  denyConditions: readonly string[];
  userExperience: UserExperience;
  lpFormFields: number | null;
  lpMobileReady: boolean | null;
  lpEvaluatedAt: Date | null;
  blogPostingProhibited: boolean;
  status: string;
}

/** `affiliate_offers.score_breakdown` に入る形（DATA_MODEL 3章） */
export interface ScoreBreakdown {
  conversionPoint: number;
  reward: number;
  lpQuality: number;
  searchDemand: number;
  experience: number;
  denyConditions: number;
  total: number;
  /** 足切りの理由。`null` なら通過 */
  excludedBy: ExclusionReason | null;
}

export interface ScoredOffer {
  offerId: string;
  breakdown: ScoreBreakdown;
  /** 足切りされていないか */
  eligible: boolean;
}

/** 成果地点の浅さ（30点）。CONTENT_PLANNING 3.1 の表そのまま */
const CONVERSION_POINTS: Readonly<Record<ConversionType, number>> = {
  FREE_SIGNUP: 30,
  REQUEST: 20,
  TRIAL: 15,
  PURCHASE: 10,
  // 表に無い。**0点にして通す**（分類できないだけで、案件は存在する）
  OTHER: 0,
};

/** 利用経験（10点） */
const EXPERIENCE_POINTS: Readonly<Record<UserExperience, number>> = {
  USED: 10,
  UNKNOWN: 3,
  NOT_USED: 0,
};

/**
 * 検索需要（15点）。
 *
 * **この写像はコード側の定数**（CONTENT_PLANNING 3.2）。AIには3値だけを
 * 返させ、点数は渡さない。
 */
const SEARCH_DEMAND_POINTS: Readonly<Record<SearchDemand, number>> = {
  HIGH: 15,
  MEDIUM: 8,
  NONE: 0,
};

/** 報酬額（20点）。段階評価 */
function rewardPoints(rewardYen: number | null): number {
  const amount = rewardYen ?? 0;

  if (amount >= 10_000) return 20;
  if (amount >= 5_000) return 15;
  if (amount >= 3_000) return 10;
  if (amount >= 1_000) return 5;

  return 0;
}

/** LPの質（20点）。フォーム項目数で決まる（D-2 の自動評価） */
function lpQualityPoints(lpFormFields: number | null): number {
  if (lpFormFields === null) return 0;
  if (lpFormFields <= 5) return 20;
  if (lpFormFields <= 10) return 10;

  return 0;
}

/** 否認条件の少なさ（5点） */
function denyConditionPoints(count: number): number {
  if (count === 0) return 5;
  if (count === 1) return 3;
  if (count === 2) return 1;

  return 0;
}

/**
 * 足切りを判定する。**該当した最初の理由を返す。**
 *
 * 順序は「案件そのものが使えない → 条件が悪い → 測れていない」。
 * **未評価を最後にする**のは、他の理由で落ちる案件をわざわざ
 * 「未評価」として ADMIN に見せないため。
 */
export function findExclusion(offer: ScorableOffer): ExclusionReason | null {
  if (offer.status === 'ENDED') {
    return EXCLUSION_REASONS.ended;
  }

  if (offer.status === 'PAUSED') {
    return EXCLUSION_REASONS.paused;
  }

  if (offer.blogPostingProhibited) {
    return EXCLUSION_REASONS.blogPostingProhibited;
  }

  const reward = offer.rewardYen ?? 0;

  if (offer.conversionType === 'PURCHASE' && reward < 3_000) {
    return EXCLUSION_REASONS.lowRewardPurchase;
  }

  if (offer.conversionType === 'FREE_SIGNUP' && reward < 800) {
    return EXCLUSION_REASONS.lowRewardFreeSignup;
  }

  if (offer.denyConditions.length >= 3) {
    return EXCLUSION_REASONS.manyDenyConditions;
  }

  // **`false` のときだけ落とす。** `null` は「非対応」ではなく「未評価」
  if (offer.lpMobileReady === false) {
    return EXCLUSION_REASONS.lpNotMobileReady;
  }

  if (offer.lpEvaluatedAt === null) {
    return EXCLUSION_REASONS.lpNotEvaluated;
  }

  return null;
}

/**
 * 1件を採点する。
 *
 * **足切りされた案件も内訳を残す。** 落ちた理由を後から確かめられないと、
 * 「なぜこの案件が採用されなかったのか」に答えられない（D-2 で
 * `lp_content_length` を残したのと同じ理由）。
 */
export function scoreOffer(
  offer: ScorableOffer,
  searchDemand: SearchDemand,
): ScoredOffer {
  const excludedBy = findExclusion(offer);

  const breakdown: ScoreBreakdown = {
    conversionPoint: CONVERSION_POINTS[offer.conversionType],
    reward: rewardPoints(offer.rewardYen),
    lpQuality: lpQualityPoints(offer.lpFormFields),
    searchDemand: SEARCH_DEMAND_POINTS[searchDemand],
    experience: EXPERIENCE_POINTS[offer.userExperience],
    denyConditions: denyConditionPoints(offer.denyConditions.length),
    total: 0,
    excludedBy,
  };

  breakdown.total =
    breakdown.conversionPoint +
    breakdown.reward +
    breakdown.lpQuality +
    breakdown.searchDemand +
    breakdown.experience +
    breakdown.denyConditions;

  return { offerId: offer.id, breakdown, eligible: excludedBy === null };
}

/**
 * 採用する案件を決める（SPEC 9.2.3「60点以上の上位3件」）。
 *
 * **足切りされた案件は点数に関わらず採用しない。** 合計が高くても、
 * 掲載できない案件は使えない。
 *
 * 同点のときは**IDで並びを固定する**。呼ぶたびに採用が入れ替わると、
 * 再実行のたびに構成表が変わる。
 */
export function adoptOffers(scored: readonly ScoredOffer[]): ScoredOffer[] {
  return [...scored]
    .filter(
      (entry) => entry.eligible && entry.breakdown.total >= ADOPTION_MIN_SCORE,
    )
    .sort(
      (a, b) =>
        b.breakdown.total - a.breakdown.total ||
        a.offerId.localeCompare(b.offerId),
    )
    .slice(0, ADOPTION_LIMIT);
}

/**
 * 未評価のまま残っている案件（ADMINへの通知に使う）。
 *
 * **落選と分けて数える。** 「点が足りなかった」と「まだ測っていない」は
 * 対応が違う（後者は D-2 の評価を走らせれば変わる）。
 */
export function unevaluatedOffers(
  scored: readonly ScoredOffer[],
): ScoredOffer[] {
  return scored.filter(
    (entry) => entry.breakdown.excludedBy === EXCLUSION_REASONS.lpNotEvaluated,
  );
}
