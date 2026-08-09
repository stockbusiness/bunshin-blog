import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getMailer, type Mailer } from '@/lib/mailer';
import { getRuntimeEnv } from '@/modules/settings';
import { findAdminByEmail, isActiveUser, type AppUser } from '@/modules/users';
import { AUTH_ERROR_CODES } from '../errors';
import { createSessionToken } from '../session';
import { resolveTokenDb, type AdminLoginDeps } from './repository';
import {
  LOGIN_TOKEN_RATE_LIMIT,
  buildLoginMail,
  buildLoginUrl,
  createLoginToken,
  hashLoginToken,
  loginTokenExpiry,
  rateWindowStart,
} from './token';

/**
 * 管理者のメール＋ワンタイムリンク（B-11、OPEN_QUESTIONS Q-012）。
 *
 * **応答を分岐させない。** 未登録・MONITOR・停止中・発行しすぎ、どの場合も
 * 呼び出し側へ同じ結果を返す。区別して返すと、どのアドレスが管理者かを
 * 外から調べられる。理由はログにのみ残す（B-1 と同じ方針）。
 */

/** ログにのみ残す内訳。**クライアントへ返さない** */
export type RequestLinkOutcome =
  'sent' | 'unknown-email' | 'not-active' | 'rate-limited' | 'send-failed';

export interface RequestLoginLinkDeps extends AdminLoginDeps {
  findAdmin?: (email: string) => Promise<AppUser | null>;
  mailer?: Mailer;
  /** `APP_BASE_URL`。リクエストの `Host` から作らない */
  baseUrl?: string;
  createToken?: () => string;
}

export interface RequestLoginLinkResult {
  /** 常に同じ。呼び出し側はこれで分岐しない */
  accepted: true;
  outcome: RequestLinkOutcome;
}

function resolveBaseUrl(deps: RequestLoginLinkDeps): string | null {
  const value = deps.baseUrl ?? process.env.APP_BASE_URL ?? '';
  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

/**
 * ログインリンクを発行して送る。
 *
 * 失敗しても例外を投げない。**送れたかどうかを呼び出し側に伝えない**ため。
 */
export async function requestAdminLoginLink(
  email: string,
  deps: RequestLoginLinkDeps = {},
): Promise<RequestLoginLinkResult> {
  const now = (deps.now ?? (() => new Date()))();
  const findAdmin = deps.findAdmin ?? findAdminByEmail;

  const admin = await findAdmin(email);
  if (admin === null) {
    logger.warn('管理者ログインリンクの要求（該当なし）', {});
    return { accepted: true, outcome: 'unknown-email' };
  }

  if (!isActiveUser(admin)) {
    logger.warn('管理者ログインリンクの要求（利用できない状態）', {
      userId: admin.id,
      status: admin.status,
    });
    return { accepted: true, outcome: 'not-active' };
  }

  const tokens = resolveTokenDb(deps);
  const issued = await tokens.countIssuedSince({
    userId: admin.id,
    since: rateWindowStart(now),
  });

  if (issued >= LOGIN_TOKEN_RATE_LIMIT) {
    // 受信箱をリンクで埋めさせない。攻撃者が繰り返し要求しても
    // 管理者に届くメールは一定数で止まる
    logger.warn('管理者ログインリンクの要求（発行しすぎ）', {
      userId: admin.id,
      issued,
    });
    return { accepted: true, outcome: 'rate-limited' };
  }

  const baseUrl = resolveBaseUrl(deps);
  if (baseUrl === null) {
    logger.error('APP_BASE_URL が未設定のためログインリンクを作れない', {});
    return { accepted: true, outcome: 'send-failed' };
  }

  const token = (deps.createToken ?? createLoginToken)();

  await tokens.create({
    userId: admin.id,
    tokenHash: hashLoginToken(token),
    expiresAt: loginTokenExpiry(now),
  });

  const mail = buildLoginMail(buildLoginUrl(baseUrl, token));
  // **`process.env` を直接見ない**（H-10）。管理画面で設定した鍵を使う
  const mailer = deps.mailer ?? getMailer({ ...(await getRuntimeEnv()) });

  try {
    await mailer.send({ to: email.trim(), ...mail });
  } catch (cause) {
    // トークンは発行済みのまま残す。消しても届いたメールは戻らず、
    // 期限切れで自然に無効になる
    logger.error('ログインリンクの送信に失敗した', {
      userId: admin.id,
      cause,
    });
    return { accepted: true, outcome: 'send-failed' };
  }

  logger.info('管理者ログインリンクを送信した', { userId: admin.id });

  return { accepted: true, outcome: 'sent' };
}

/** リンクの検証に失敗したときに返す。理由は区別しない */
function invalidLinkError(reason: string): AppError {
  return new AppError(
    AUTH_ERROR_CODES.invalidLoginLink,
    401,
    'このリンクは使用できません。もう一度ログインをやり直してください',
    { cause: { reason } },
  );
}

export interface ConsumeLoginLinkDeps extends AdminLoginDeps {
  findById?: (id: string) => Promise<AppUser | null>;
  secret?: string;
}

export interface ConsumeLoginLinkResult {
  user: AppUser;
  sessionToken: string;
}

/**
 * リンクを使ってセッションを発行する。
 *
 * **1回だけ使える。** 使用済みにできた場合のみ先へ進む。
 *
 * @throws {AppError} 401 未登録・期限切れ・使用済み・ADMINでない
 */
export async function consumeAdminLoginLink(
  token: string,
  deps: ConsumeLoginLinkDeps = {},
): Promise<ConsumeLoginLinkResult> {
  const now = (deps.now ?? (() => new Date()))();
  const tokens = resolveTokenDb(deps);

  if (token.trim() === '') {
    throw invalidLinkError('empty-token');
  }

  const record = await tokens.findByHash(hashLoginToken(token));
  if (record === null) {
    throw invalidLinkError('not-found');
  }

  if (record.usedAt !== null) {
    throw invalidLinkError('already-used');
  }

  if (record.expiresAt.getTime() <= now.getTime()) {
    throw invalidLinkError('expired');
  }

  // **ここが「1回だけ」の実体。** 未使用のものだけを更新し、
  // 0件なら他の要求が先に使ったと判断する
  const updated = await tokens.markUsed({ id: record.id, usedAt: now });
  if (updated === 0) {
    throw invalidLinkError('race-lost');
  }

  const findUser = deps.findById ?? (await import('@/modules/users')).findById;
  const user = await findUser(record.userId);

  if (user === null || user.role !== 'ADMIN' || !isActiveUser(user)) {
    // 発行後に権限を落とされた場合。トークンは使用済みのままにする
    throw invalidLinkError('not-admin');
  }

  return {
    user,
    sessionToken: createSessionToken(user.id, {
      ...(deps.secret === undefined ? {} : { secret: deps.secret }),
      now: () => now,
    }),
  };
}
