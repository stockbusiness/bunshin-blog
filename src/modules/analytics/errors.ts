import { AppError } from '@/lib/errors';

/** analytics モジュールのエラーコード（TASKS D-8） */
export const ANALYTICS_ERROR_CODES = {
  /** リダイレクタのコードに対応するリンクが無い */
  linkNotFound: 'ANALYTICS_LINK_NOT_FOUND',
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
