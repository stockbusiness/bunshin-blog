import { createHmac, timingSafeEqual } from 'node:crypto';
import { getServerEnv } from '@/lib/env';

/**
 * セッション（B-2、SPEC 13.1「セッション発行」）。
 *
 * 署名付きCookieを使う。Phase 0 の規模（モニター10名）でセッション用の
 * ストアを持つ必要が無く、DBへの往復も増やしたくないため。
 *
 * **CookieにはユーザーIDと期限だけを入れる。** ロールや同意状態を入れると、
 * 権限をはく奪しても古いCookieが有効なままになる。判定のたびにDBを見る。
 */

/** セッションCookieの名前 */
export const SESSION_COOKIE_NAME = 'bunshin_session';

/** セッションの有効期間（日） */
export const SESSION_TTL_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(body: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(body).digest());
}

export interface SessionOptions {
  secret?: string;
  now?: () => Date;
}

function resolveSecret(options: SessionOptions): string {
  return options.secret ?? getServerEnv().SESSION_SECRET;
}

/**
 * セッションCookieの値を作る。
 *
 * @param userId 検証済みのIDトークンから解決した内部ユーザーID
 */
export function createSessionToken(
  userId: string,
  options: SessionOptions = {},
): string {
  const now = (options.now ?? (() => new Date()))().getTime();
  const payload: SessionPayload = {
    userId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_DAYS * MS_PER_DAY,
  };

  const body = base64url(JSON.stringify(payload));

  return `${body}.${sign(body, resolveSecret(options))}`;
}

/**
 * セッションCookieの値を検証する。
 *
 * 署名が合わない・期限切れ・形式不正はいずれも `null` を返す。
 * 呼び出し側が失敗理由で分岐しないようにするため、区別しない。
 */
export function verifySessionToken(
  token: string,
  options: SessionOptions = {},
): SessionPayload | null {
  if (typeof token !== 'string') {
    return null;
  }

  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(body, resolveSecret(options));

  // 比較時間から署名を推測されないようにする
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as SessionPayload).userId !== 'string' ||
    typeof (payload as SessionPayload).expiresAt !== 'number' ||
    typeof (payload as SessionPayload).issuedAt !== 'number'
  ) {
    return null;
  }

  const session = payload as SessionPayload;
  if (session.userId === '') {
    return null;
  }

  const now = (options.now ?? (() => new Date()))().getTime();
  if (session.expiresAt <= now) {
    return null;
  }

  return session;
}

/** `Set-Cookie` ヘッダの値を作る */
export function buildSessionCookie(
  token: string,
  options: { secure?: boolean } = {},
): string {
  const secure =
    (options.secure ?? process.env.NODE_ENV === 'production') ? '; Secure' : '';

  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`,
    secure,
  ]
    .filter((part) => part !== '')
    .join('; ');
}
