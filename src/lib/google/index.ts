/**
 * Google API の公開インターフェース（TASKS G-1）。
 *
 * **サーバー専用。** `node:crypto` で鍵を扱うため、ブラウザ向けのコードから
 * import しない（MODULE_RULES 4）。
 */

export {
  parseServiceAccountKey,
  signAssertion,
  fetchAccessToken,
  isTokenExpired,
  GOOGLE_TOKEN_ENDPOINT,
  SEARCH_CONSOLE_SCOPE,
  TOKEN_EXPIRY_MARGIN_MS,
  type FetchAccessTokenOptions,
} from './service-account';

export {
  createSearchConsoleClient,
  isPermissionLevel,
  SEARCH_CONSOLE_API_BASE,
  PERMISSION_LEVELS,
  type SearchConsoleClient,
  type CreateSearchConsoleClientOptions,
  type PermissionLevel,
  type SiteCheckOutcome,
} from './search-console';

export {
  createSearchAnalyticsClient,
  SearchAnalyticsError,
  SEARCH_ANALYTICS_MAX_ROWS,
  SEARCH_ANALYTICS_MAX_PAGES,
  type SearchAnalyticsClient,
  type CreateSearchAnalyticsClientOptions,
  type SearchAnalyticsQuery,
  type SearchAnalyticsRow,
} from './search-analytics';

export {
  GoogleNotConfiguredError,
  GoogleServiceAccountInvalidError,
  GoogleAuthError,
  type GoogleServiceAccount,
  type GoogleAccessToken,
} from './types';
