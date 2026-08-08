import { AppError } from '@/lib/errors';

/**
 * affiliate モジュールのエラーコード（TASKS D-1）。
 *
 * LP自動評価（D-2）とリダイレクタ（D-8）のコードは各タスクで追加する。
 */
export const AFFILIATE_ERROR_CODES = {
  /** 入力の形式が受け付けられない */
  invalidOffer: 'AFFILIATE_INVALID_OFFER',
  /** URLの形式が受け付けられない */
  invalidUrl: 'AFFILIATE_INVALID_URL',
  /** 掲載期間の前後が逆 */
  invalidPeriod: 'AFFILIATE_INVALID_PERIOD',
  /** `REDIRECT` なのにリダイレクタのコードが無い */
  missingRedirectCode: 'AFFILIATE_MISSING_REDIRECT_CODE',
  /** リダイレクタの公開URLが設定されていない */
  redirectNotConfigured: 'AFFILIATE_REDIRECT_NOT_CONFIGURED',
} as const;

export type AffiliateErrorCode =
  (typeof AFFILIATE_ERROR_CODES)[keyof typeof AFFILIATE_ERROR_CODES];

/**
 * 入力の不備を表す。
 *
 * **理由をモニターへ返す。** 認証と違い、ここは入力ミスの訂正が目的で、
 * 何が悪いかを伝えないと直しようがない（C-1 の `invalidSiteUrlError` と同じ方針）。
 */
export function invalidOfferError(reason: string): AppError {
  return new AppError(
    AFFILIATE_ERROR_CODES.invalidOffer,
    422,
    `案件の内容を確認してください：${reason}`,
  );
}

export function invalidUrlError(field: string, reason: string): AppError {
  return new AppError(
    AFFILIATE_ERROR_CODES.invalidUrl,
    422,
    `${field}を確認してください：${reason}`,
  );
}

export function invalidPeriodError(): AppError {
  return new AppError(
    AFFILIATE_ERROR_CODES.invalidPeriod,
    422,
    '掲載終了日は開始日より後にしてください',
  );
}

/**
 * `REDIRECT` の案件にリダイレクタのコードが渡されなかったことを表す。
 *
 * **呼び出し側の誤り。** 500 で落とす。ここを 422 にすると、記事生成が
 * 「入力が悪い」と誤解して再試行を続ける。
 */
export function missingRedirectCodeError(): AppError {
  return new AppError(
    AFFILIATE_ERROR_CODES.missingRedirectCode,
    500,
    'リダイレクトする案件にはリダイレクタのコードが必要です',
  );
}

/** `APP_BASE_URL` が無く、リダイレクタのURLを組み立てられない */
export function redirectNotConfiguredError(): AppError {
  return new AppError(
    AFFILIATE_ERROR_CODES.redirectNotConfigured,
    500,
    'リダイレクタの公開URLが設定されていません',
  );
}

/**
 * LPの自動評価（TASKS D-2、SPEC 9.2.3・14.3）。
 *
 * **到達できない理由を細かく分けない。** 到達禁止アドレスと接続失敗を
 * 区別すると、応答の違いで内部の構成を調べられる（SPEC 14.3）。
 */
export const LP_ERROR_CODES = {
  /** LPへ到達できなかった */
  lpUnreachable: 'AFFILIATE_LP_UNREACHABLE',
  /** HTMLが返らなかった */
  lpNotHtml: 'AFFILIATE_LP_NOT_HTML',
  /** 取得はできたが評価できなかった */
  lpUnavailable: 'AFFILIATE_LP_UNAVAILABLE',
} as const;

export type LpErrorCode = (typeof LP_ERROR_CODES)[keyof typeof LP_ERROR_CODES];

/** LPの取得・評価の失敗を表す。到達先や内部の理由をメッセージへ含めない */
export function lpFetchFailedError(
  code: LpErrorCode,
  message: string,
  cause?: unknown,
): AppError {
  return new AppError(code, 502, message, cause === undefined ? {} : { cause });
}
