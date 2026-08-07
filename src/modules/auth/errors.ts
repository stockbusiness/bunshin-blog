import { AppError } from '@/lib/errors';

/**
 * auth モジュール固有のエラーコード。
 *
 * **クライアントへは「認証に失敗した」以上の情報を返さない。**
 * 失敗理由（署名不正・期限切れ・チャネル不一致）を返すと、
 * 攻撃者にトークンの改竄結果を教えることになる。理由はログにのみ残す。
 */
export const AUTH_ERROR_CODES = {
  /** IDトークンの検証に失敗した（署名・形式・期限・チャネルのいずれか） */
  invalidIdToken: 'AUTH_INVALID_ID_TOKEN',
  /** LINEの検証エンドポイントへ到達できなかった */
  verificationUnavailable: 'AUTH_VERIFICATION_UNAVAILABLE',
  /** セッションが無い・不正・期限切れ */
  unauthenticated: 'AUTH_UNAUTHENTICATED',
  /** 利用規約またはデータ利用への同意が済んでいない */
  consentRequired: 'AUTH_CONSENT_REQUIRED',
  /** 停止・退会などで利用できない状態 */
  userNotActive: 'AUTH_USER_NOT_ACTIVE',
  /** 認証は済んでいるが ADMIN ではない（B-6） */
  adminRequired: 'AUTH_ADMIN_REQUIRED',
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** クライアントへ返すメッセージは一律にする */
const INVALID_MESSAGE = '認証に失敗しました';

/**
 * IDトークンが不正であることを表す。
 *
 * @param reason ログにのみ残す理由。クライアントへは返さない
 */
export function invalidIdTokenError(reason: string, cause?: unknown): AppError {
  return new AppError(
    AUTH_ERROR_CODES.invalidIdToken,
    401,
    INVALID_MESSAGE,
    // reason は details ではなく cause に入れる。details はクライアントへ返る
    { cause: { reason, ...(cause === undefined ? {} : { cause }) } },
  );
}

/** LINEの検証エンドポイントへ到達できなかったことを表す */
export function verificationUnavailableError(cause?: unknown): AppError {
  return new AppError(
    AUTH_ERROR_CODES.verificationUnavailable,
    503,
    '認証サーバーへ接続できませんでした。時間をおいて再度お試しください',
    cause === undefined ? {} : { cause },
  );
}
