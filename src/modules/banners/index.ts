/**
 * banners モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `banners` テーブルを触ってよいのはこのモジュールだけ。
 *
 * **IDだけでバナーを引く関数を公開しない**（SPEC 14.1）。全ての取得・更新は
 * `userId` と `blogId` を伴う。
 *
 * **依存は `banners` → `affiliate` の一方向**（MODULE_RULES 3）。
 * 案件との紐付けを確かめるために `affiliate` の公開関数を使う。
 */

export {
  listBannersForUser,
  findBannerForUser,
  findBannerByCodeInBlog,
  requireBannerForUser,
  createBannerForUser,
  updateBannerForUser,
  endBannerForUser,
} from './repository';

export {
  normalizeCreateBanner,
  normalizeUpdateBanner,
  normalizeImageUrl,
  normalizeDestinationUrl,
  normalizeTargetCategories,
  assertBannerPeriod,
  isBannerSlot,
  isBannerStatus,
  BANNER_NAME_MAX_LENGTH,
  BANNER_URL_MAX_LENGTH,
  TARGET_CATEGORY_MAX_LENGTH,
  TARGET_CATEGORIES_MAX,
  type NormalizedCreateBanner,
} from './validate';

export {
  BANNER_ERROR_CODES,
  invalidBannerError,
  invalidBannerUrlError,
  invalidBannerPeriodError,
  type BannerErrorCode,
} from './errors';

export {
  BANNER_SLOTS,
  BANNER_STATUSES,
  type AppBanner,
  type BannerSlot,
  type BannerStatus,
  type CreateBannerInput,
  type UpdateBannerInput,
} from './types';
