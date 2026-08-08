import { AppError } from '@/lib/errors';

/** AI呼び出しのエラーコード（TASKS E-3） */
export const AI_ERROR_CODES = {
  /** 設定が足りない（モデル名・APIキーなど） */
  notConfigured: 'AI_NOT_CONFIGURED',
  /** プロバイダーへ到達できない */
  unreachable: 'AI_UNREACHABLE',
  /** プロバイダーがエラーを返した */
  requestFailed: 'AI_REQUEST_FAILED',
  /** 応答の形が想定と違う */
  invalidResponse: 'AI_INVALID_RESPONSE',
  /** 時間内に応答しなかった */
  timeout: 'AI_TIMEOUT',
} as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

/**
 * 設定不足を表す。
 *
 * **APIキーの値をメッセージへ入れない**（SPEC 14.2）。入れるのは
 * 変数名だけ。
 */
export function aiNotConfiguredError(reason: string): AppError {
  return new AppError(AI_ERROR_CODES.notConfigured, 500, reason);
}

/**
 * 呼び出しの失敗を表す。
 *
 * **プロバイダーの応答本文をそのまま返さない。** 課金情報や内部の
 * 識別子が混ざりうる。
 */
export function aiRequestFailedError(
  code: AiErrorCode,
  message: string,
  cause?: unknown,
): AppError {
  return new AppError(code, 502, message, cause === undefined ? {} : { cause });
}
