/**
 * banners モジュールが外部へ渡す表現（TASKS D-3、SPEC 5.9）。
 */

/** 表示位置（SPEC 5.9） */
export type BannerSlot =
  'TOP' | 'AFTER_FIRST_HEADING' | 'MIDDLE' | 'BOTTOM' | 'SIDEBAR';

export type BannerStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export const BANNER_SLOTS: readonly BannerSlot[] = [
  'TOP',
  'AFTER_FIRST_HEADING',
  'MIDDLE',
  'BOTTOM',
  'SIDEBAR',
];

export const BANNER_STATUSES: readonly BannerStatus[] = [
  'ACTIVE',
  'PAUSED',
  'ENDED',
];

export interface AppBanner {
  id: string;
  blogId: string;
  name: string;
  imageUrl: string;
  destinationUrl: string;
  /** 紐づく案件。無ければ `null` */
  affiliateOfferId: string | null;
  slot: BannerSlot;
  /** 出す記事のカテゴリ。空なら全ての記事が対象 */
  targetCategories: string[];
  status: BannerStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBannerInput {
  name: string;
  imageUrl: string;
  destinationUrl: string;
  affiliateOfferId?: string | undefined;
  slot: BannerSlot;
  targetCategories?: string[] | undefined;
  status?: BannerStatus | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

export interface UpdateBannerInput {
  name?: string | undefined;
  imageUrl?: string | undefined;
  destinationUrl?: string | undefined;
  affiliateOfferId?: string | null | undefined;
  slot?: BannerSlot | undefined;
  targetCategories?: string[] | undefined;
  status?: BannerStatus | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
}
