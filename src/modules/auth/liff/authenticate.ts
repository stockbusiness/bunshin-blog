import { findOrCreateByLineUserId, type AppUser } from '@/modules/users';
import type { UsersDeps } from '@/modules/users';
import { createSessionToken, type SessionOptions } from '../session';
import {
  verifyLiffIdToken,
  type VerifyLiffIdTokenOptions,
} from './verify-id-token';

/**
 * LIFF認証の一連の流れ（B-2、SPEC 13.1）。
 *
 * 1. IDトークンを検証する
 * 2. `line_user_id` から内部ユーザーを引く。無ければ作る
 * 3. セッションを発行する
 *
 * **`line_user_id` は検証済みトークンの `sub` のみを源とする。**
 * この関数はユーザーIDを引数に取らない（SPEC 3.2）。
 */

export interface AuthenticateOptions
  extends VerifyLiffIdTokenOptions, SessionOptions, UsersDeps {}

export interface AuthenticateResult {
  user: AppUser;
  sessionToken: string;
  /** 今回の認証で新規登録されたか。オンボーディングへの誘導に使う */
  created: boolean;
}

export async function authenticateWithLiff(
  idToken: string,
  options: AuthenticateOptions = {},
): Promise<AuthenticateResult> {
  const claims = await verifyLiffIdToken(idToken, options);

  // 表示名が取れない場合もLINE側の設定次第であり得る
  const displayName = claims.displayName ?? 'モニター';

  const { user, created } = await findOrCreateByLineUserId(
    claims.lineUserId,
    displayName,
    options,
  );

  return {
    user,
    sessionToken: createSessionToken(user.id, options),
    created,
  };
}
