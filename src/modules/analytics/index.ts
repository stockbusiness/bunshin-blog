/**
 * analytics モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `metrics_daily` `link_clicks` `search_console_connections` を触ってよいのは
 * このモジュールだけ。本タスク（D-8）で実装したのは `link_clicks` のみ。
 *
 * **`...ForUser` の形を取らない。** クリックするのは記事の読者で、
 * ログインしていない。所有権の判定に使える情報が無い。
 */

export { recordLinkClick, countLinkClicks } from './repository';

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
