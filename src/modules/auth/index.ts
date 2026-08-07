/**
 * auth モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * ここから export していない関数を外部から呼ばない。
 *
 * **`line_user_id` は必ず `verifyLiffIdToken` の戻り値から取る。**
 * クライアントが送ってきたユーザーIDを受け取る関数は、ここに置かない
 * （SPEC 3.2「クライアントが送信したユーザーIDを信用しない」）。
 */

export {
  verifyLiffIdToken,
  LINE_VERIFY_ENDPOINT,
  LINE_ISSUER,
  type LiffIdTokenClaims,
  type VerifyLiffIdTokenOptions,
} from './liff/verify-id-token';

export {
  authenticateWithLiff,
  type AuthenticateOptions,
  type AuthenticateResult,
} from './liff/authenticate';

export {
  createSessionToken,
  verifySessionToken,
  buildSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  type SessionPayload,
  type SessionOptions,
} from './session';

export {
  requireUser,
  requireConsentedUser,
  requireAdmin,
  readSessionCookie,
  type GuardOptions,
} from './guard';

export {
  requestAdminLoginLink,
  consumeAdminLoginLink,
  type RequestLoginLinkDeps,
  type RequestLoginLinkResult,
  type RequestLinkOutcome,
  type ConsumeLoginLinkDeps,
  type ConsumeLoginLinkResult,
} from './admin-login/service';

export {
  createLoginToken,
  hashLoginToken,
  loginTokenExpiry,
  rateWindowStart,
  buildLoginUrl,
  buildLoginMail,
  loginTokenHashEquals,
  LOGIN_TOKEN_TTL_MINUTES,
  LOGIN_TOKEN_RATE_LIMIT,
  LOGIN_TOKEN_RATE_WINDOW_MINUTES,
} from './admin-login/token';

export type {
  AdminLoginTokenDb,
  AdminLoginTokenRecord,
  AdminLoginDeps,
} from './admin-login/repository';

export { AUTH_ERROR_CODES, type AuthErrorCode } from './errors';
