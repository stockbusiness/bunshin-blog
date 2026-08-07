import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ワンタイムログイントークンの生成と照合（B-11、OPEN_QUESTIONS Q-012）。
 *
 * **DBに保存するのはハッシュだけ。** 原文を保存すると、DBを読めた相手が
 * そのまま管理者としてログインできる（B-10）。
 */

/** 有効期間。短くする。メールは受信箱に残り続ける */
export const LOGIN_TOKEN_TTL_MINUTES = 15;

/** トークンの長さ（バイト）。base64url で43文字になる */
const TOKEN_BYTES = 32;

/** 同一ユーザーへ続けて発行できる回数と、その集計期間 */
export const LOGIN_TOKEN_RATE_LIMIT = 3;
export const LOGIN_TOKEN_RATE_WINDOW_MINUTES = 15;

/** 推測できないトークンを作る */
export function createLoginToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 保存・照合用のハッシュ。
 *
 * **ソルトを付けない。** トークン自体が32バイトの乱数で、総当たりも
 * 辞書攻撃も成立しない。ソルトを付けるとハッシュから引けなくなる。
 */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 期限を計算する */
export function loginTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + LOGIN_TOKEN_TTL_MINUTES * 60 * 1000);
}

/** 発行数を数える起点 */
export function rateWindowStart(now: Date): Date {
  return new Date(now.getTime() - LOGIN_TOKEN_RATE_WINDOW_MINUTES * 60 * 1000);
}

/**
 * ハッシュを比較する。
 *
 * 比較時間から一致部分を推測されないようにする。長さが違えば即座に
 * `false`（長さは秘密ではない）。
 */
export function loginTokenHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * メールに載せるログインURLを組み立てる。
 *
 * **`baseUrl` はリクエストの `Host` から作らない**（Q-013）。偽の `Host`
 * を送られると、リンクの向き先を攻撃者のドメインへ差し替えられる。
 * 必ず `APP_BASE_URL` から渡すこと。
 */
export function buildLoginUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');

  return `${base}/admin/login/verify?token=${encodeURIComponent(token)}`;
}

/** ログインリンクのメール本文 */
export function buildLoginMail(loginUrl: string): {
  subject: string;
  text: string;
} {
  return {
    subject: 'BUNSHIN BLOG 管理画面へのログイン',
    text: [
      '管理画面へのログインリンクです。',
      '',
      loginUrl,
      '',
      `このリンクは ${String(LOGIN_TOKEN_TTL_MINUTES)} 分間、1回だけ使えます。`,
      'お心当たりが無い場合は、このメールを破棄してください。',
    ].join('\n'),
  };
}
