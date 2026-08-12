/**
 * content-generation モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `article_versions` `prompt_versions` を触ってよいのはこのモジュールだけ。
 * 本タスク（E-2）で実装したのは `prompt_versions` のみ。
 *
 * **プロンプトは利用者に紐づかない。** システム全体で1組で、触れるのは
 * ADMIN だけ（SPEC 6.2）。`...ForAdmin` の名前で横断参照であることを示す。
 */

export {
  findActivePrompt,
  requireActivePrompt,
  listPromptVersionsForAdmin,
  findPromptVersionForAdmin,
  createPromptVersionForAdmin,
  activatePromptVersionForAdmin,
  deactivatePromptForAdmin,
} from './repository';

export {
  generateArticleForUser,
  type GenerateArticleForUserInput,
  type GenerateArticleDeps,
} from './generate';

export {
  factCheckArticleForUser,
  type FactCheckArticleInput,
  type FactCheckArticleDeps,
  type FactCheckArticleResult,
} from './fact-check-service';

export {
  verifyClaims,
  judgeFactCheck,
  factCheckAllowsApproval,
  areFactsStale,
  checkAgainstFacts,
  flattenFactStrings,
  extractNumbers,
  normalizeForMatch,
  CLAIM_TYPES,
  FACTS_STALE_DAYS,
  type ClaimType,
  type ExtractedClaim,
  type UnverifiedClaim,
  type UnverifiedReason,
  type FactCheckStatus,
  type VerifyClaimsInput,
} from './fact-check';

export { extractClaims, type ExtractClaimsResult } from './claim-extraction';

export { listApprovableArticlesForUser } from './approvable';

export type { ApprovableArticle } from './article-repository';

export {
  scanRiskFlagsForUser,
  type ScanRiskFlagsInput,
  type ScanRiskFlagsResult,
} from './risk-flag-service';

export {
  detectRiskFlags,
  detectProhibitedExpressions,
  detectNgExpressions,
  detectPrDisclosureMissing,
  hasBlockingRiskFlag,
  canSendToApproval,
  stripTags,
  type RiskFlag,
  type RiskFlagCode,
  type RiskSeverity,
} from './risk-flags';

export {
  requirePlannedItemForUser,
  listArticleVersionsForUser,
  listSiblingItemsForUser,
  findLatestArticleVersion,
  readArticleVersionDetailForUser,
  saveArticleVersion,
  saveFactCheckResult,
  saveRiskFlags,
  type AppArticleVersion,
  type SaveArticleVersionInput,
  type ArticleVersionDetail,
} from './article-repository';

export {
  extractHrefs,
  assertAllowedLinks,
  assertPrDisclosure,
  assertUsedFacts,
  assertAnswerCapsule,
  assertFaq,
  assertNoH1,
  composeBodyWithCapsule,
  countCharacters,
  articleContentHash,
  ANSWER_CAPSULE_MIN_LENGTH,
  ANSWER_CAPSULE_MAX_LENGTH,
  FAQ_MIN_COUNT,
  FAQ_MAX_COUNT,
  PR_DISCLOSURE_PATTERNS,
} from './article';

export {
  buildStructuredData,
  assertValidJsonLd,
  type BuildStructuredDataInput,
  type StructuredDataFaq,
  type JsonLdBlock,
} from './structured-data';

export {
  generateArticle,
  operationForContentType,
  GENERATION_PROMPT_KEYS,
  type GeneratedArticle,
  type ArticleGenerationInput,
  type ArticleGenerationAttempt,
  type GenerateArticleResult,
} from './ai';

export {
  normalizeCreatePromptVersion,
  normalizePromptKey,
  normalizePromptVersion,
  PROMPT_KEY_MAX_LENGTH,
  PROMPT_VERSION_MAX_LENGTH,
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_NOTES_MAX_LENGTH,
  type NormalizedPromptVersion,
} from './prompt';

export {
  PROMPT_ERROR_CODES,
  invalidPromptError,
  duplicateVersionError,
  promptNotFoundError,
  noActiveVersionError,
  invalidArticleError,
  invalidStructuredDataError,
  itemNotInPlanError,
  type PromptErrorCode,
} from './errors';

export type { AppPromptVersion, CreatePromptVersionInput } from './types';

export {
  makeBodyReadable,
  addHeadingIds,
  collectHeadings,
  buildTableOfContents,
  ensureImageAlt,
  ensureTableHeaders,
  TOC_MIN_HEADINGS,
  type TocEntry,
} from './readable';
