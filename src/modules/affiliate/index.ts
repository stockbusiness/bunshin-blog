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
  evaluateLandingPageForUser,
  ensureRedirectLinkForUser,
  findRedirectTargetByCode,
  findLinkByCodeInBlog,
  type AppAffiliateLink,
} from './repository';

export { saveOfferScoresForUser, type OfferScoreInput } from './scoring';

export {
  generateRedirectCode,
  isRedirectCode,
  REDIRECT_CODE_LENGTH,
} from './redirect-link';

export {
  evaluateLandingPage,
  evaluateHtml,
  countFormFields,
  detectMobileReady,
  LP_TIMEOUT_MS,
  LP_MAX_BYTES,
  LP_CONTENT_TYPES,
  LP_FORM_FIELDS_GOOD,
  LP_FORM_FIELDS_FAIR,
  type LpEvaluation,
  type EvaluateLandingPageOptions,
} from './lp-evaluation';

export {
  CSV_FIELDS,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  applyMapping,
  decodeCsvBytes,
  parseCsv,
  readConversionType,
  readRewardYen,
  readStatus,
  sanitizeMapping,
  suggestColumnMapping,
  toScorableShape,
  type ColumnMapping,
  type CsvFieldKey,
  type CsvTable,
  type ImportCandidate,
  type SuggestMappingDeps,
} from './csv-import';

export {
  OFFER_CATALOG_STATUSES,
  LINK_MODES,
  createCatalogItemForAdmin,
  listCatalogForAdmin,
  listOffersNeedingFactCheckForUser,
  listSelectableCatalog,
  readCatalogItem,
  updateCatalogItemForAdmin,
  type CatalogItemInput,
  type OfferCatalogItem,
  type OfferCatalogStatus,
  type OfferFactAlert,
} from './catalog';

export {
  draftOfferFromLandingPage,
  htmlToText,
  OFFER_DRAFT_PROMPT_KEY,
  type OfferDraft,
} from './offer-draft';

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
  LP_ERROR_CODES,
  lpFetchFailedError,
  type AffiliateErrorCode,
  type LpErrorCode,
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

export {
  checkOfferLinksForUser,
  listBrokenOfferLinksForUser,
  judgeLinkHealth,
  type BrokenOfferLink,
  type LinkHealth,
  type OfferLinkCheck,
  type CheckOfferLinksDeps,
} from './link-check';
