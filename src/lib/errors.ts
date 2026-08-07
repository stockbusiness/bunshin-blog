/**
 * 共通エラーレスポンス（TASKS A-4）。
 *
 * 方針:
 * - 想定内のエラーは `AppError` として投げ、コードと状況をクライアントへ返す
 * - 想定外の例外は 500 に丸め、内部の詳細をクライアントへ返さない
 *   （SPEC 14.2「クライアントへ秘密情報を返さない」）
 */

import { logger, redact, scrubString, type Logger } from '@/lib/logger';

/**
 * 汎用のエラーコード。モジュール固有のコード（C-2 の接続テストなど）は
 * 各モジュールで定義し、`AppError` の `code` に渡す。
 */
export const GENERIC_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type GenericErrorCode = (typeof GENERIC_ERROR_CODES)[number];

/** モジュール固有のコードも許容する */
export type ErrorCode = GenericErrorCode | (string & {});

export interface AppErrorOptions {
  /** クライアントへ返す補足情報。秘密情報を入れないこと */
  details?: Record<string, unknown>;
  /** 元の例外。ログにのみ出力し、クライアントへは返さない */
  cause?: unknown;
}

/** クライアントへ返してよい、想定内のエラー */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.code = code;
    this.status = status;
    this.details = options.details;
  }

  static badRequest(message: string, options?: AppErrorOptions): AppError {
    return new AppError('BAD_REQUEST', 400, message, options);
  }

  static unauthorized(
    message = '認証が必要です',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError('UNAUTHORIZED', 401, message, options);
  }

  static forbidden(
    message = 'この操作は許可されていません',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError('FORBIDDEN', 403, message, options);
  }

  static notFound(
    message = '対象が見つかりません',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError('NOT_FOUND', 404, message, options);
  }

  static conflict(message: string, options?: AppErrorOptions): AppError {
    return new AppError('CONFLICT', 409, message, options);
  }

  static validationFailed(
    message = '入力内容を確認してください',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError('VALIDATION_FAILED', 422, message, options);
  }

  static rateLimited(
    message = '時間をおいて再度お試しください',
    options?: AppErrorOptions,
  ): AppError {
    return new AppError('RATE_LIMITED', 429, message, options);
  }
}

/** クライアントへ返すエラー本文 */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

/** 想定外の例外でクライアントへ返す固定メッセージ */
export const INTERNAL_ERROR_MESSAGE = '内部エラーが発生しました';

export interface ToErrorResponseOptions {
  requestId?: string;
  logger?: Logger;
}

/**
 * 例外をHTTPステータスとレスポンス本文に変換し、サーバー側へログを残す。
 *
 * `AppError` 以外は 500 に丸め、元のメッセージをクライアントへ返さない。
 * 想定外の例外のメッセージにはSQL断片や接続情報が混ざりうるため。
 */
export function toErrorResponse(
  error: unknown,
  options: ToErrorResponseOptions = {},
): { status: number; body: ErrorResponseBody } {
  const log = options.logger ?? logger;
  const requestId = options.requestId;

  if (error instanceof AppError) {
    const fields: Record<string, unknown> = {
      code: error.code,
      status: error.status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    };

    // 4xxは運用上の異常ではないため warn に留める
    if (error.status >= 500) {
      log.error(error.message, fields);
    } else {
      log.warn(error.message, fields);
    }

    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: scrubString(error.message),
          ...(error.details === undefined
            ? {}
            : { details: redact(error.details) as Record<string, unknown> }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      },
    };
  }

  log.error('未処理の例外', {
    ...(requestId === undefined ? {} : { requestId }),
    cause: error,
  });

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: INTERNAL_ERROR_MESSAGE,
        ...(requestId === undefined ? {} : { requestId }),
      },
    },
  };
}

/** Route Handler からそのまま返せる `Response` を作る */
export function toErrorHttpResponse(
  error: unknown,
  options: ToErrorResponseOptions = {},
): Response {
  const { status, body } = toErrorResponse(error, options);

  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
