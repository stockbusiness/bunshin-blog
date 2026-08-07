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

export { AUTH_ERROR_CODES, type AuthErrorCode } from './errors';
