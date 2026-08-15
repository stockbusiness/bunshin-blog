import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSameSite, normalizeSiteUrl } from './site-url';

/**
 * WordPress の認可フロー（TASKS I-8、SPEC 7.1 v2.3）。
 *
 * ## なぜ入れるのか
 *
 * これまでは、モニターが WordPress の管理画面で
 * **アプリケーションパスワードを発行し、コピーして貼り付けていた**
 * （`MANUAL.md` 段6）。**オンボーディングで最も脱落しやすい箇所**で、
 * 「接続テストが通るまでが1つの作業」と書かねばならなかった。
 *
 * WordPress 5.6 以降には認可フローがある。モニターは自分の WordPress で
 * **「承認」を1回押すだけ**でよい。
 *
 * ## `state` に署名する
 *
 * **ここが要。** 署名が無いと、細工したリンクを踏ませることで
 * **攻撃者のサイトを他人のブログ枠につながせられる**（戻り先は
 * `success_url` の1本しか無く、どの依頼に対する戻りなのかを
 * 戻り自体からは区別できない）。
 *
 * `state` に **利用者・ブログ・サイトURLの3つ**を入れて署名し、
 * 戻ってきたときに照合する。**3つとも要る。**
 *
 * | 欠けると | 起きること |
 * |---|---|
 * | 利用者 | 他人が始めた依頼の戻りを自分のものにできる |
 * | ブログ | 自分の別のブログ枠へ差し替えられる |
 * | サイトURL | **依頼したのと違うサイトの資格情報を受け取る** |
 *
 * **有効期間を短くする。** 承認は目の前で行う操作で、時間を置いて
 * 戻ってくる理由が無い。
 *
 * ## 手で貼る経路を消さない
 *
 * 認可フローは **HTTPS のサイトでしか使えない**（WordPress が拒む）。
 * これは `normalizeSiteUrl` が既に強制しているので**ここで見直さない。**
 * WordPress 5.6 より前や、`wp-admin` を独自の場所へ移したサイトでは
 * 開けない。**片方しか無いと、そこで詰まった人が先へ進めない。**
 */

/** 認可の依頼が有効な時間（分）。**承認は目の前で行う操作である** */
export const AUTHORIZE_STATE_TTL_MINUTES = 15;

/** WordPress の承認画面に出るアプリ名 */
export const AUTHORIZE_APP_NAME = 'BUNSHIN BLOG';

export interface AuthorizeState {
  userId: string;
  blogId: string;
  /** 正規化済みのサイトURL */
  siteUrl: string;
  expiresAt: number;
}

export interface AuthorizeOptions {
  secret: string;
  now?: Date | undefined;
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

/**
 * 認可の依頼を表す署名付きの値を作る。
 *
 * **サイトURLは正規化して入れる。** 戻りの `site_url` と比べるとき、
 * 末尾のスラッシュや大文字小文字の違いで一致しないことがある。
 */
export function createAuthorizeState(
  params: { userId: string; blogId: string; siteUrl: string },
  options: AuthorizeOptions,
): string {
  const now = (options.now ?? new Date()).getTime();

  const payload: AuthorizeState = {
    userId: params.userId,
    blogId: params.blogId,
    siteUrl: normalizeSiteUrl(params.siteUrl),
    expiresAt: now + AUTHORIZE_STATE_TTL_MINUTES * 60_000,
  };

  const body = base64url(JSON.stringify(payload));

  return `${body}.${sign(body, options.secret)}`;
}

/**
 * 戻ってきた `state` を検証する。
 *
 * **署名違い・期限切れ・形式不正をいずれも `null` にする。**
 * 呼び出し側が理由で分岐すると、外から状態を調べる手がかりになる
 * （`verifySessionToken` と同じ方針）。
 */
export function verifyAuthorizeState(
  state: string,
  options: AuthorizeOptions,
): AuthorizeState | null {
  if (typeof state !== 'string') {
    return null;
  }

  const separator = state.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }

  const body = state.slice(0, separator);
  const given = Buffer.from(state.slice(separator + 1));
  const want = Buffer.from(sign(body, options.secret));

  // 比較時間から署名を推測されないようにする
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (
    typeof record['userId'] !== 'string' ||
    typeof record['blogId'] !== 'string' ||
    typeof record['siteUrl'] !== 'string' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null;
  }

  if (record['expiresAt'] <= (options.now ?? new Date()).getTime()) {
    return null;
  }

  return {
    userId: record['userId'],
    blogId: record['blogId'],
    siteUrl: record['siteUrl'],
    expiresAt: record['expiresAt'],
  };
}

/**
 * WordPress の承認画面のURLを組み立てる。
 *
 * **`wp-admin` の位置は決め打ちにする。** REST API の入口
 * （`deriveApiBaseUrl`）とは別で、探る手段が無い。移したサイトでは
 * 開けないが、**そのために手で貼る経路を残してある。**
 *
 * ## `state` は戻り先のURLに埋める
 *
 * **WordPress は `state` を返さない。** `authorize-application.php` が
 * 見るのは `app_name` `app_id` `success_url` `reject_url` だけで、
 * **知らないパラメータは捨てる。** 戻りに載るのは `site_url`・
 * `user_login`・`password` の3つだけである。
 *
 * **最初は `state` を認証URLの独立したパラメータとして渡していた。**
 * そのため戻りに `state` が無く、**承認しても「取り消された」として
 * 扱われた**（本番で判明・2026-08-15）。
 *
 * `success_url` は WordPress が `add_query_arg` で組み立て直すので、
 * **こちらが付けた問い合わせ文字列はそのまま残る。** そこへ埋める。
 */
export function buildAuthorizeUrl(params: {
  siteUrl: string;
  successUrl: string;
  state: string;
}): string {
  const url = new URL(
    '/wp-admin/authorize-application.php',
    `${normalizeSiteUrl(params.siteUrl)}/`,
  );

  // **戻り先そのものに `state` を持たせる**（上記）
  const returnUrl = new URL(params.successUrl);
  returnUrl.searchParams.set('state', params.state);
  const returnTo = returnUrl.toString();

  url.searchParams.set('app_name', AUTHORIZE_APP_NAME);
  url.searchParams.set('success_url', returnTo);
  // **拒否したときも戻す。** 戻らないと、モニターは WordPress の
  // 画面に取り残されて「何が起きたのか」が分からない
  url.searchParams.set('reject_url', returnTo);

  return url.toString();
}

/**
 * 戻ってきた `site_url` が、依頼したサイトと同じか。
 *
 * **違うサイトの資格情報を受け取らない。** WordPress は自分の
 * `site_url` を戻りに載せるので、ここで食い違うのは
 * **依頼と違うサイトで承認された**ということである。
 */
export function matchesRequestedSite(
  state: AuthorizeState,
  returnedSiteUrl: string | null,
): boolean {
  if (returnedSiteUrl === null || returnedSiteUrl.trim() === '') {
    // **載っていないことを許さない。** 確かめられないまま繋ぐと、
    // 署名だけが根拠になる
    return false;
  }

  try {
    return isSameSite(state.siteUrl, normalizeSiteUrl(returnedSiteUrl));
  } catch {
    return false;
  }
}
