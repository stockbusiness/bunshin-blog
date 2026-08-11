import { AppError } from '@/lib/errors';

/** analytics モジュールのエラーコード（TASKS D-8・G-1） */
export const ANALYTICS_ERROR_CODES = {
  /** リダイレクタのコードに対応するリンクが無い */
  linkNotFound: 'ANALYTICS_LINK_NOT_FOUND',
  /** Search Console のプロパティのURLの形が違う（G-1） */
  invalidPropertyUrl: 'ANALYTICS_INVALID_PROPERTY_URL',
  /** そのブログはまだ Search Console と結びついていない（G-1） */
  searchConsoleNotConnected: 'ANALYTICS_SEARCH_CONSOLE_NOT_CONNECTED',
} as const;

export type AnalyticsErrorCode =
  (typeof ANALYTICS_ERROR_CODES)[keyof typeof ANALYTICS_ERROR_CODES];

/**
 * リンクが見つからないことを表す。
 *
 * **理由を分けない。** 「コードが存在しない」と「案件が終了した」を
 * 区別すると、コードの総当たりで有効なリンクの有無を調べられる。
 */
export function linkNotFoundError(): AppError {
  return new AppError(
    ANALYTICS_ERROR_CODES.linkNotFound,
    404,
    'リンクが見つかりません',
  );
}

/**
 * プロパティのURLの形が違うことを表す（G-1）。
 *
 * **受け付ける形を文言に書く。** Search Console のプロパティには
 * ドメインプロパティとURLプレフィックスがあり、**モニターがどちらを
 * 作ったかはこちらで決められない。** 「形式が違います」だけでは直せない。
 */
export function invalidPropertyUrlError(): AppError {
  return new AppError(
    ANALYTICS_ERROR_CODES.invalidPropertyUrl,
    400,
    'Search Console のプロパティを、https://example.com/ または sc-domain:example.com の形で入力してください',
  );
}

/** まだ結びついていないブログを確かめようとした（G-1） */
export function searchConsoleNotConnectedError(): AppError {
  return new AppError(
    ANALYTICS_ERROR_CODES.searchConsoleNotConnected,
    404,
    'このブログはまだ Search Console と連携していません',
  );
}
