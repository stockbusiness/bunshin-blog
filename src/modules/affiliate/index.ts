/**
 * affiliate モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `affiliate_offers` `affiliate_links` テーブルを触ってよいのは
 * このモジュールだけ。
 *
 * **リンクの組み立ては `buildAffiliateLink` に集約する**（Q-001）。
 * 記事生成（E-10）もバナー（D-3）もリダイレクタ（D-8）もここを通す。
 * `link_mode` の分岐を呼び出し側に書かせない。
 *
 * **IDだけで案件を引く関数を公開しない**（SPEC 14.1）。全ての取得・更新は
 * `userId` と `blogId` を伴う。
 */

export {
  listOffersForUser,
  findOfferForUser,
  requireOfferForUser,
  createOfferForUser,
  updateOfferForUser,
  endOfferForUser,
  readLinkableOfferForUser,
} from './repository';

export {
  buildAffiliateLink,
  buildSubId,
  buildRedirectUrl,
  appendSubId,
  SUB_ID_SEPARATOR,
  REDIRECT_PATH,
  type LinkableOffer,
  type AffiliateLinkTarget,
  type BuildAffiliateLinkOptions,
} from './link';

export {
  normalizeCreateOffer,
  normalizeUpdateOffer,
  normalizeOfferUrl,
  assertPeriod,
  isConversionType,
  isUserExperience,
  isOfferStatus,
  OFFER_NAME_MAX_LENGTH,
  ASP_NAME_MAX_LENGTH,
  ADVERTISER_NAME_MAX_LENGTH,
  OFFER_URL_MAX_LENGTH,
  DENY_CONDITION_MAX_LENGTH,
  DENY_CONDITIONS_MAX,
  REWARD_YEN_MAX,
  USER_RATING_MIN,
  USER_RATING_MAX,
  type NormalizedCreateOffer,
} from './validate';

export {
  AFFILIATE_ERROR_CODES,
  invalidOfferError,
  invalidUrlError,
  invalidPeriodError,
  missingRedirectCodeError,
  redirectNotConfiguredError,
  type AffiliateErrorCode,
} from './errors';

export {
  CONVERSION_TYPES,
  USER_EXPERIENCES,
  OFFER_STATUSES,
  type AppAffiliateOffer,
  type CreateOfferInput,
  type UpdateOfferInput,
  type ConversionType,
  type UserExperience,
  type OfferStatus,
  type LinkMode,
} from './types';
