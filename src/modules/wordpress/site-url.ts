/**
 * WordPress サイトURLの正規化と検証（TASKS C-1）。
 *
 * DBアクセスを持たない純粋な処理。**保存前に必ず通す。**
 *
 * ここでやるのは「形式の検証」まで。実際に到達するか・REST APIが応答するかは
 * SPEC 7.2 の接続テスト（C-2）で確かめる。
 */

import { invalidSiteUrlError, siteUrlImmutableError } from './errors';

/** URL全体の上限。DBは text だが、異常に長い値を保存しない */
export const SITE_URL_MAX_LENGTH = 255;

/**
 * REST API のベース（書き換えが効くサイト）。
 *
 * パーマリンク設定が「基本」のサイトでは、WordPress が `/wp-json/` の
 * 書き換え規則を作らないため**この道は404になる。** その場合は
 * `PLAIN_REST_PATH` を使う（Q-052）。
 */
const REST_PATH = '/wp-json';

/**
 * 書き換えが効かないサイト向けの REST API のベース。
 *
 * **WordPress が自分でこの形を案内する。** パーマリンクが「基本」のとき、
 * `/wp-json/` の応答にある `_links.self` は
 * `index.php?rest_route=/` になっている。
 *
 * **`/index.php` は書き換えを通らない**ので、`.htaccess` が効いていない
 * サイトでも届く。
 */
const PLAIN_REST_PATH = '/index.php';

/** IPv4 リテラル。ホスト名として受け付けない */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 到達先として認めないホスト。実験対象は独自ドメインのサイトに限る */
const BLOCKED_HOSTS = new Set(['localhost']);

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.test'];

/**
 * 入力されたURLを保存用の形へ正規化する。
 *
 * - スキームの省略は `https://` を補う（モニターは `example.com` と書く）
 * - `https` 以外は拒否する。アプリケーションパスワードは Basic 認証で
 *   送るため、平文の `http` では毎回そのまま流れる
 * - 末尾の `/` を落とし、ホストを小文字にする。同じサイトが表記違いで
 *   別サイト扱いになると Q-007 の一致確認が働かない
 *
 * @throws {AppError} 形式が不正な場合（422）
 */
export function normalizeSiteUrl(input: string): string {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw invalidSiteUrlError('未入力です');
  }

  if (trimmed.length > SITE_URL_MAX_LENGTH) {
    throw invalidSiteUrlError(
      `${SITE_URL_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidSiteUrlError('URLとして読み取れません');
  }

  if (url.protocol !== 'https:') {
    throw invalidSiteUrlError('https:// で始まるURLを指定してください');
  }

  if (url.username !== '' || url.password !== '') {
    throw invalidSiteUrlError(
      'URLにユーザー名やパスワードを含めないでください',
    );
  }

  if (url.search !== '' || url.hash !== '') {
    throw invalidSiteUrlError('クエリやハッシュを含めないでください');
  }

  // 既定以外のポートは受け付けない。独自ドメイン＋一般的なレンタルサーバー
  // を前提にしており（OPEN_QUESTIONS Q-002）、任意ポートを許すと
  // 到達先の範囲がむやみに広がる
  if (url.port !== '' && url.port !== '443') {
    throw invalidSiteUrlError('ポート番号を含めないでください');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (host === '' || !host.includes('.')) {
    throw invalidSiteUrlError('ドメイン名を指定してください');
  }

  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw invalidSiteUrlError('公開されているサイトのURLを指定してください');
  }

  if (IPV4.test(host) || host.startsWith('[')) {
    throw invalidSiteUrlError('IPアドレスではなくドメイン名を指定してください');
  }

  const path = url.pathname.replace(/\/+$/, '');

  return `https://${host}${path}`;
}

/**
 * REST API のベースURLを導く。
 *
 * `site_url` と別列で持つのは SPEC 5.4 のスキーマがそうなっているため。
 * 現状は導出できるが、独自の設置形態を後から扱えるように列は残す。
 */
export function deriveApiBaseUrl(normalizedSiteUrl: string): string {
  return `${normalizedSiteUrl}${REST_PATH}`;
}

/** 書き換えを通らない REST のベース（Q-052） */
export function derivePlainApiBaseUrl(normalizedSiteUrl: string): string {
  return `${normalizedSiteUrl}${PLAIN_REST_PATH}`;
}

/**
 * 保存済みのベースがどちらの形かを判定する。
 *
 * **列を増やさない。** ベースの末尾で決まるので、保存した文字列から
 * 一意に読み取れる（`api_base_url` は SPEC 5.4 の既存列）。
 */
export function restStyleOf(apiBaseUrl: string): 'pretty' | 'plain' {
  return apiBaseUrl.endsWith(PLAIN_REST_PATH) ? 'plain' : 'pretty';
}

/** 正規化済みの2つが同じサイトを指すか */
export function isSameSite(a: string, b: string): boolean {
  return a === b;
}

/**
 * 接続先の変更を拒否する（OPEN_QUESTIONS Q-007）。
 *
 * - **別サイトへの変更は拒否する。** 接続先が変わると `wordpress_posts`・
 *   `metrics_daily`・Search Console のデータが別サイトのものと混ざり、
 *   実験データとして読めなくなる
 * - **同一URLのままの再接続は許可する。** 認証情報の入れ替え・権限の
 *   付け直し・接続エラーからの復旧に必要
 * - `REVOKED`（切断済み）でも `site_url` は保持しており、同じく一致を見る
 *
 * @param stored 保存済みの `site_url`。未接続なら `undefined`
 * @param incoming 正規化済みの入力
 * @throws {AppError} 別サイトへ変更しようとした場合（409）
 */
export function assertSiteUrlUnchanged(params: {
  stored: string | undefined;
  incoming: string;
}): void {
  const { stored, incoming } = params;

  if (stored === undefined) {
    return;
  }

  if (!isSameSite(stored, incoming)) {
    throw siteUrlImmutableError();
  }
}
