/**
 * 外向きHTTPの失敗を表す（TASKS C-7）。
 *
 * ここでは `AppError` を使わない。**利用者へどう見せるかは呼び出し側が決める。**
 * C-2（接続テスト）は「REST APIに到達できない」と伝えたいが、
 * D-2（LP自動評価）はジョブの中で握りつぶして次へ進む、といった具合に扱いが違う。
 */

export const HTTP_ERROR_CODES = {
  /** URLの形式が受け付けられない（http/https 以外、資格情報つきなど） */
  invalidUrl: 'HTTP_INVALID_URL',
  /** 名前解決できなかった */
  dnsFailed: 'HTTP_DNS_FAILED',
  /** 到達を認めないアドレスだった（private・loopback・link-local など） */
  blockedAddress: 'HTTP_BLOCKED_ADDRESS',
  /** 時間内に応答しなかった */
  timeout: 'HTTP_TIMEOUT',
  /** 応答が大きすぎる */
  tooLarge: 'HTTP_RESPONSE_TOO_LARGE',
  /** 転送が多すぎる */
  tooManyRedirects: 'HTTP_TOO_MANY_REDIRECTS',
  /** 期待した Content-Type ではなかった */
  unexpectedContentType: 'HTTP_UNEXPECTED_CONTENT_TYPE',
  /** 接続そのものが失敗した（TLS・切断など） */
  requestFailed: 'HTTP_REQUEST_FAILED',
} as const;

export type HttpErrorCode =
  (typeof HTTP_ERROR_CODES)[keyof typeof HTTP_ERROR_CODES];

export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly code: HttpErrorCode;

  /**
   * ログにのみ残す補足。
   *
   * **解決したIPや内部の理由をここへ入れる。** クライアントへ返す文言は
   * 呼び出し側が作るため、ここには調査に必要な情報を入れてよい。
   */
  readonly detail: string | undefined;

  constructor(
    code: HttpErrorCode,
    message: string,
    options: { detail?: string | undefined; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.code = code;
    this.detail = options.detail;
  }
}

export function isHttpFetchError(value: unknown): value is HttpFetchError {
  return value instanceof HttpFetchError;
}
