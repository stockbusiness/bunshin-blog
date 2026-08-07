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
