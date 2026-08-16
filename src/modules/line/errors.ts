import { AppError } from '@/lib/errors';

/** line モジュールのエラーコード（TASKS F-2） */
export const LINE_ERROR_CODES = {
  /** LINE 送信の設定が足りない */
  notConfigured: 'LINE_NOT_CONFIGURED',
  /** 通知の宛先が無い（未連携、または `ACTIVE` でない） */
  targetMissing: 'LINE_TARGET_MISSING',
} as const;

export type LineErrorCode =
  (typeof LINE_ERROR_CODES)[keyof typeof LINE_ERROR_CODES];

/**
 * 設定不足を表す。
 *
 * **足りない項目名だけを載せる。値は載せない**（SPEC 14.2）。
 * 500 なのは利用者の入力ではなく運用の設定が原因だから。
 */
export function lineNotConfiguredError(missing: readonly string[]): AppError {
  return new AppError(
    LINE_ERROR_CODES.notConfigured,
    500,
    `LINE通知の設定が不足しています：${missing.join(', ')}`,
  );
}

/** リッチメニューのエラーコード（Q-054） */
export const RICH_MENU_ERROR_CODES = {
  /** 保存しようとした値が LINE の決まりに合わない */
  invalid: 'RICH_MENU_INVALID',
  /** 画像を受け取れない（形式・大きさ・縦横比） */
  imageRejected: 'RICH_MENU_IMAGE_REJECTED',
  /** 適用に必要なもの（画像・押す場所）が揃っていない */
  notReady: 'RICH_MENU_NOT_READY',
  /** いま出ているものを消そうとした */
  inUse: 'RICH_MENU_IN_USE',
} as const;

export type RichMenuErrorCode =
  (typeof RICH_MENU_ERROR_CODES)[keyof typeof RICH_MENU_ERROR_CODES];

/**
 * リッチメニューの入力を断る。
 *
 * **400 で返す。** 直すのは操作した ADMIN であって、運用の設定ではない
 * （`lineNotConfiguredError` が 500 なのと対になる）。
 * `inUse` だけは状態の衝突なので 409。
 */
export function richMenuError(
  code: RichMenuErrorCode,
  message: string,
): AppError {
  return new AppError(
    code,
    code === RICH_MENU_ERROR_CODES.inUse ? 409 : 400,
    message,
  );
}

/**
 * 宛先が無いことを表す。
 *
 * **黙って送らないで終わらせない。** 「送ったつもり」で提案が
 * 誰にも届かない状態が続くのを防ぐ。
 */
export function notificationTargetMissingError(): AppError {
  return new AppError(
    LINE_ERROR_CODES.targetMissing,
    409,
    'LINEの連携が確認できないため通知を送れません',
  );
}
