import { AppError } from '@/lib/errors';

/** settings モジュールのエラーコード（TASKS H-7） */
export const SETTING_ERROR_CODES = {
  /** 設定できる名前ではない */
  unknownKey: 'SETTING_UNKNOWN_KEY',
  /** 値の形式が受け付けられない */
  invalidValue: 'SETTING_INVALID_VALUE',
  /** 設定されていない */
  notFound: 'SETTING_NOT_FOUND',
} as const;

export type SettingErrorCode =
  (typeof SETTING_ERROR_CODES)[keyof typeof SETTING_ERROR_CODES];

/**
 * 設定できる名前ではないことを表す。
 *
 * **任意の名前を受け取らない。** 受け取れるようにすると、管理画面が
 * 「アプリの環境変数を何でも書き換えられる入口」になる。
 */
export function unknownSettingError(key: string): AppError {
  return new AppError(
    SETTING_ERROR_CODES.unknownKey,
    404,
    `${key} は設定できる項目にありません`,
  );
}

/**
 * 値の形式が違うことを表す。
 *
 * **入力値をメッセージへ含めない。** 秘密の設定でも同じ経路を通るため、
 * 含めるとAPIキーがエラーメッセージとして出ていく。
 */
export function invalidSettingValueError(
  key: string,
  reason: string,
): AppError {
  return new AppError(
    SETTING_ERROR_CODES.invalidValue,
    422,
    `${key} の値を確認してください：${reason}`,
  );
}

export function settingNotFoundError(key: string): AppError {
  return new AppError(
    SETTING_ERROR_CODES.notFound,
    404,
    `${key} は設定されていません`,
  );
}
