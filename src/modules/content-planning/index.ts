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
  STEP1_PROMPT_KEYS,
  STEP2_PROMPT_KEYS,
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
  type PlanningErrorCode,
} from './errors';

export type { AppPlanningRun, GenreReviewResult } from './types';
