/**
 * affiliate モジュールが外部へ渡す表現（TASKS D-1、SPEC 5.8）。
 */

export type ConversionType =
  'FREE_SIGNUP' | 'REQUEST' | 'TRIAL' | 'PURCHASE' | 'OTHER';

export type UserExperience = 'USED' | 'NOT_USED' | 'UNKNOWN';

export type OfferStatus =
  'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'NEEDS_REVIEW';

/** リンクの出し方（D-9・Q-001）。既定は `DIRECT`（安全側） */
export type LinkMode = 'REDIRECT' | 'DIRECT';

export const CONVERSION_TYPES: readonly ConversionType[] = [
  'FREE_SIGNUP',
  'REQUEST',
  'TRIAL',
  'PURCHASE',
  'OTHER',
];

export const USER_EXPERIENCES: readonly UserExperience[] = [
  'USED',
  'NOT_USED',
  'UNKNOWN',
];

export const OFFER_STATUSES: readonly OfferStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ENDED',
  'NEEDS_REVIEW',
];

/**
 * 案件の外向け表現。
 *
 * **`sub_id_param` を含めない。** ADMIN が運用で入れる値で（Q-014）、
 * モニターの画面に出す理由が無い。リンクの組み立てにしか使わない。
 */
export interface AppAffiliateOffer {
  id: string;
  blogId: string;
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  affiliateUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  facts: unknown;
  /**
   * `facts` を**確かめ直した**時刻（D-13・Q-022）。
   * **`null` は「一度も確かめていない」**（`updatedAt` とは別物）。
   *
   * 90日より古ければ、照合が一致しても `WARNING`（CONTENT_PLANNING 8.2）
   */
  factsUpdatedAt: Date | null;
  userExperience: UserExperience;
  userRating: number | null;
  denyConditions: string[];
  /** LPのフォーム項目数（D-2 の自動評価）。未評価なら `null` */
  lpFormFields: number | null;
  /** LPがスマートフォン対応か（D-2）。未評価なら `null` */
  lpMobileReady: boolean | null;
  /** LPを評価した時刻。`null` なら未評価で、**スコアリングの対象外**（E-5） */
  lpEvaluatedAt: Date | null;
  /** ブログへの掲載が禁じられているか（Q-019）。ADMIN が設定する */
  blogPostingProhibited: boolean;
  /** STEP 2 の得点（E-5）。未採点なら `null` */
  selectionScore: number | null;
  /** 得点の内訳（DATA_MODEL 3章）。未採点なら `null` */
  scoreBreakdown: unknown;
  status: OfferStatus;
  linkMode: LinkMode;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOfferInput {
  name: string;
  aspName: string;
  advertiserName?: string | undefined;
  landingPageUrl: string;
  affiliateUrl: string;
  rewardYen?: number | undefined;
  conversionType: ConversionType;
  facts?: unknown;
  userExperience?: UserExperience | undefined;
  userRating?: number | undefined;
  denyConditions?: string[] | undefined;
  status?: OfferStatus | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

/**
 * 更新の入力。
 *
 * **`link_mode` と `sub_id_param` を含めない。** どちらも ASP の規約に
 * 関わる判断で、**モニターに判断させない**（Q-001・Q-014）。設定するのは
 * ADMIN で、Phase 0 は SQL（SPEC 10.3 と同じ扱い）。
 */
export interface UpdateOfferInput {
  name?: string | undefined;
  aspName?: string | undefined;
  advertiserName?: string | null | undefined;
  landingPageUrl?: string | undefined;
  affiliateUrl?: string | undefined;
  rewardYen?: number | null | undefined;
  conversionType?: ConversionType | undefined;
  facts?: unknown;
  userExperience?: UserExperience | undefined;
  userRating?: number | null | undefined;
  denyConditions?: string[] | undefined;
  status?: OfferStatus | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
}
