/**
 * analytics モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `metrics_daily` `link_clicks` `search_console_connections` を触ってよいのは
 * このモジュールだけ。本タスク（D-8）で実装したのは `link_clicks` のみ。
 *
 * **`...ForUser` の形を取らない。** クリックするのは記事の読者で、
 * ログインしていない。所有権の判定に使える情報が無い。
 */

export {
  recordLinkClick,
  countLinkClicks,
  recountAiReferrals,
  countAiReferrals,
} from './repository';

export {
  connectSearchConsoleForUser,
  findSearchConsoleConnectionForUser,
  testSearchConsoleForUser,
  disconnectSearchConsoleForUser,
  createConfiguredSearchConsoleClient,
  readServiceAccountEmail,
  normalizePropertyUrl,
  type AppSearchConsoleConnection,
  type ConnectSearchConsoleResult,
  type PropertyKind,
  type SearchConsoleCheck,
  type SearchConsoleDeps,
  type SearchConsoleFailureCode,
} from './search-console';

export {
  fetchSearchMetricsForUser,
  enqueueSearchMetricsForUser,
  createConfiguredSearchAnalyticsClient,
  fetchWindow,
  shiftDate,
  normalizePageUrl,
  LOOKBACK_DAYS,
  type SearchMetricsDeps,
  type SearchMetricsSummary,
} from './search-metrics';

export {
  fetchIndexStatusForUser,
  enqueueIndexStatusForUser,
  createConfiguredUrlInspectionClient,
  URL_INSPECTION_PER_RUN,
  type IndexStatusDeps,
  type IndexStatusSummary,
} from './index-status';

export {
  aggregateDailyMetricsForUser,
  enqueueDailyAggregateForUser,
  AGGREGATE_LOOKBACK_DAYS,
  type DailyAggregateSummary,
} from './daily-aggregate';

export {
  isAiReferralHost,
  matchesDomain,
  resolveAiReferralDomains,
  AI_REFERRAL_DOMAINS,
} from './ai-referral';

export {
  saveWeeklyResultForUser,
  listWeeklyResultsForUser,
  normalizeWeeklyResult,
  weekOf,
  WEEKLY_RESULT_ERROR_CODES,
  MAX_CONVERSIONS_PER_WEEK,
  MAX_REVENUE_YEN_PER_WEEK,
  type WeeklyResult,
  type WeeklyResultInput,
  type WeeklyResultRow,
} from './weekly-result';

export {
  parseReferrerHost,
  hashUserAgent,
  REFERRER_HOST_MAX_LENGTH,
} from './click';

export {
  ANALYTICS_ERROR_CODES,
  linkNotFoundError,
  type AnalyticsErrorCode,
} from './errors';

export type { AppLinkClick, RecordClickInput } from './types';
