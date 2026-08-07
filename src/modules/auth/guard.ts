import { AppError } from '@/lib/errors';
import {
  findById,
  hasAllConsents,
  isActiveUser,
  missingConsents,
  type AppUser,
  type UsersDeps,
} from '@/modules/users';
import { AUTH_ERROR_CODES } from './errors';
import { SESSION_COOKIE_NAME, verifySessionToken } from './session';
import type { SessionOptions } from './session';

/**
 * APIの入口で使う認証・同意チェック（B-2）。
 *
 * **完了条件「同意なしで他APIが403」をここで担保する。**
 * 各Route Handlerが個別に同意を確認すると、必ず書き忘れが出る。
 */

export interface GuardOptions extends SessionOptions, UsersDeps {}

/** Cookieヘッダからセッションの値を取り出す */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null || cookieHeader === '') {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      const value = rest.join('=');
      return value === '' ? null : value;
    }
  }

  return null;
}

/**
 * セッションからユーザーを解決する。同意は見ない。
 *
 * オンボーディング中（同意前）でも使えるAPIのためにこちらを使う。
 *
 * @throws {AppError} 401 未認証・停止・退会
 */
export async function requireUser(
  cookieHeader: string | null,
  options: GuardOptions = {},
): Promise<AppUser> {
  const token = readSessionCookie(cookieHeader);
  if (token === null) {
    throw new AppError(AUTH_ERROR_CODES.unauthenticated, 401, '認証が必要です');
  }

  const session = verifySessionToken(token, options);
  if (session === null) {
    throw new AppError(AUTH_ERROR_CODES.unauthenticated, 401, '認証が必要です');
  }

  // ロールと同意はCookieに入れず、毎回DBを見る。
  // 停止したユーザーが古いCookieで通り続けるのを防ぐ
  const user = await findById(session.userId, options);
  if (user === null) {
    throw new AppError(AUTH_ERROR_CODES.unauthenticated, 401, '認証が必要です');
  }

  if (!isActiveUser(user)) {
    throw new AppError(
      AUTH_ERROR_CODES.userNotActive,
      403,
      'このアカウントは利用できません',
    );
  }

  return user;
}

/**
 * セッションからユーザーを解決し、ADMIN であることを確認する（B-6）。
 *
 * **`/admin` 配下の画面とAPIはこれを通す。** 完了条件「MONITORが `/admin`
 * へアクセスできない」をここで担保する。
 *
 * **同意は見ない。** 利用規約とデータ利用への同意は、実験に参加する
 * モニターに求めるもの（SPEC 6.1 のオンボーディング）。運営者を
 * 同意状態で締め出すと、同意周りの不具合が起きたときに管理画面から
 * 直せなくなる。
 *
 * **403 を返す（404 ではない）。** B-3 で所有していない資源に 404 を
 * 返すのは、IDの総当たりで他人の資源の有無を調べられるのを防ぐため。
 * `/admin` は固定のパスで総当たりの対象にならず、隠しても得るものが無い。
 *
 * @throws {AppError} 401 未認証／403 停止・退会・ADMINでない
 */
export async function requireAdmin(
  cookieHeader: string | null,
  options: GuardOptions = {},
): Promise<AppUser> {
  const user = await requireUser(cookieHeader, options);

  if (user.role !== 'ADMIN') {
    throw new AppError(
      AUTH_ERROR_CODES.adminRequired,
      403,
      'この画面は管理者のみ利用できます',
    );
  }

  return user;
}

/**
 * セッションからユーザーを解決し、同意が揃っていることを確認する。
 *
 * **オンボーディング以外の全APIはこちらを使う。**
 *
 * @throws {AppError} 401 未認証／403 同意なし・停止・退会
 */
export async function requireConsentedUser(
  cookieHeader: string | null,
  options: GuardOptions = {},
): Promise<AppUser> {
  const user = await requireUser(cookieHeader, options);

  if (!hasAllConsents(user)) {
    // どの同意が足りないかはクライアントへ返してよい。
    // 秘密ではなく、オンボーディングへ誘導するために必要
    throw new AppError(
      AUTH_ERROR_CODES.consentRequired,
      403,
      '利用開始には同意が必要です',
      { details: { missingConsents: missingConsents(user) } },
    );
  }

  return user;
}
