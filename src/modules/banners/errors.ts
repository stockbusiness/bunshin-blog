import { AppError } from '@/lib/errors';

/** banners モジュールのエラーコード（TASKS D-3） */
export const BANNER_ERROR_CODES = {
  /** 入力の形式が受け付けられない */
  invalidBanner: 'BANNER_INVALID',
  /** URLの形式が受け付けられない */
  invalidUrl: 'BANNER_INVALID_URL',
  /** 掲載期間の前後が逆 */
  invalidPeriod: 'BANNER_INVALID_PERIOD',
} as const;

export type BannerErrorCode =
  (typeof BANNER_ERROR_CODES)[keyof typeof BANNER_ERROR_CODES];

/** 入力の不備を表す。**理由をモニターへ返す**（直しようがなくなるため） */
export function invalidBannerError(reason: string): AppError {
  return new AppError(
    BANNER_ERROR_CODES.invalidBanner,
    422,
    `バナーの内容を確認してください：${reason}`,
  );
}

export function invalidBannerUrlError(field: string, reason: string): AppError {
  return new AppError(
    BANNER_ERROR_CODES.invalidUrl,
    422,
    `${field}を確認してください：${reason}`,
  );
}

export function invalidBannerPeriodError(): AppError {
  return new AppError(
    BANNER_ERROR_CODES.invalidPeriod,
    422,
    '掲載終了日時は開始日時より後にしてください',
  );
}
