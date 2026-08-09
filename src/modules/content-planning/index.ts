/**
 * content-planning モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `content_plans` `content_items` `planning_runs` を触ってよいのは
 * このモジュールだけ。本タスク（E-4）で実装したのは `planning_runs` のみ。
 *
 * **判定はこのモジュールのコードが行う。** AIは案と説明文を出す係で、
 * 可否を決めない（CONTENT_PLANNING 1.1）。
 */

export {
  reviewGenreForUser,
  overrideGenreBlockForUser,
  listPlanningRunsForUser,
  type ReviewGenreInput,
  type ReviewGenreDeps,
} from './service';

export {
  judgeGenre,
  offersOverride,
  MAX_REJECTIONS,
  SERP_SAMPLE_SIZE,
  SERP_MAJOR_BLOCK_THRESHOLD,
  SERP_PERSONAL_WARN_MAX,
  STEP1_BLOCK_REASONS,
  STEP1_WARN_REASONS,
  type SerpEntry,
  type SerpDomainType,
  type Step1Input,
  type Step1Judgement,
  type Step1Decision,
  type Step1BlockReason,
  type Step1WarnReason,
  type YmylRisk,
  type GenreCandidate,
  filterAlternatives,
} from './step1';

export {
  scoreOffersForUser,
  type ScoreOffersInput,
  type ScoreOffersDeps,
  type ScoreOffersResult,
} from './step2-service';

export {
  scoreOffer,
  adoptOffers,
  findExclusion,
  unevaluatedOffers,
  SCORE_MAX,
  ADOPTION_MIN_SCORE,
  ADOPTION_LIMIT,
  EXCLUSION_REASONS,
  type ScorableOffer,
  type ScoredOffer,
  type ScoreBreakdown,
  type ExclusionReason,
  type SearchDemand,
} from './step2';

export {
  designRevenueArticlesForUser,
  type DesignRevenueArticlesInput,
  type DesignRevenueArticlesDeps,
  type DesignRevenueArticlesResult,
} from './step3-service';

export {
  planRevenueSlots,
  matchRevenueTitles,
  revenueArticleCount,
  REVENUE_ARTICLE_MAX,
  REVENUE_PATTERN_LABELS,
  type RevenuePattern,
  type RevenueSlot,
  type RevenueTitle,
  type AdoptedOffer,
  type PlannedRevenueItem,
} from './step3';

export {
  listContentItemsForUser,
  listPlanItemsWithLinksForUser,
  findLatestPlanForUser,
  type AppContentItem,
  type NewContentItem,
} from './plan-repository';

export {
  designTrafficArticlesForUser,
  type DesignTrafficArticlesInput,
  type DesignTrafficArticlesDeps,
  type DesignTrafficArticlesResult,
} from './step4-service';

export {
  normalizeKeyword,
  findKeywordConflicts,
  applyKeywordRepairs,
  assertOutboundAreAffiliate,
  assignLinks,
  countInboundPerRevenue,
  OUTBOUND_LINK_MAX,
  INBOUND_LINK_MIN,
  type KeywordCandidate,
  type KeywordConflict,
  type LinkableItem,
  type TrafficItemDraft,
} from './step4';

export {
  appendItemsToPlanForUser,
  saveLinksForUser,
  savePublishOrderForUser,
} from './plan-repository';

export {
  buildPlanForUser,
  MAX_PLAN_RETRIES,
  type BuildPlanInput,
  type JobPlanInput,
  type BuildPlanDeps,
  type BuildPlanResult,
  type BuildPlanAttempt,
} from './plan-builder';

export {
  assignPublishOrder,
  revenueFitsInInitialWeeks,
  ABSOLUTE_WEEKLY_CAP,
  REVENUE_WEEKS,
  type OrderableItem,
  type PublishSlot,
} from './publish-order';

export {
  checkConstraints,
  buildRepairHints,
  CONSTRAINT_CODES,
  TOTAL_ARTICLE_MAX,
  INBOUND_MIN,
  OUTBOUND_MAX,
  WEEKLY_PUBLISH_CAP,
  type ConstraintCode,
  type ConstraintResult,
  type ConstraintViolation,
  type CheckableItem,
  type RepairHints,
} from './constraints';

export {
  STEP1_PROMPT_KEYS,
  STEP2_PROMPT_KEYS,
  STEP3_PROMPT_KEYS,
  STEP4_PROMPT_KEYS,
  ALTERNATIVE_GENRE_COUNT,
  type AlternativeGenre,
  type GenreReviewText,
} from './ai';

export {
  PLANNING_ERROR_CODES,
  invalidStep1InputError,
  genreNotFoundError,
  overrideNotAllowedError,
  invalidAiResponseError,
  invalidStep3InputError,
  invalidStep4InputError,
  planNotFoundError,
  planningNotConvergedError,
  invalidPublishOrderError,
  type PlanningErrorCode,
} from './errors';

export type { AppPlanningRun, GenreReviewResult } from './types';
