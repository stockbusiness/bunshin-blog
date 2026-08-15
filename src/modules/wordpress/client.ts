/**
 * WordPress REST API のクライアント（TASKS C-2、SPEC 7.1）。
 *
 * 認証はアプリケーションパスワードの Basic 認証。
 *
 * **宛先はモニターが入力したURLなので、必ず `safeFetch` を通す**
 * （C-7、SPEC 14.3）。`fetch` を直接呼ばない。
 *
 * **Authorization ヘッダーを組み立てるのはこのファイルだけ。**
 * `Secret` から取り出した値をここより外へ持ち出さない（SPEC 14.2）。
 */

import { safeFetch, type SafeFetchResponse } from '@/lib/http';
import { restStyleOf } from './site-url';
import type { WordpressCredentials } from './types';

/** WordPress の応答が JSON でなければ、そもそも REST API ではない */
const JSON_CONTENT_TYPES = ['application/json'] as const;

/** 接続テストは待たせすぎない。SPEC 7.2 の7項目を順に叩くため */
export const WORDPRESS_TIMEOUT_MS = 10_000;

/** 投稿一覧は1件しか取らない。大きな応答を読む場面が無い */
export const WORDPRESS_MAX_BYTES = 1024 * 1024;

export interface WordpressApiResponse {
  status: number;
  headers: Record<string, string>;
  /** パースできなければ `null`。呼び出し側で形を確かめる */
  json: unknown;
  /** 応答の生文字列。ログには出さない */
  raw: string;
}

export interface WordpressRequest {
  /** `apiBaseUrl` からの相対パス。先頭の `/` を含める */
  path: string;
  method?: string;
  body?: unknown;
  /** `false` にすると認証ヘッダーを付けない（到達確認に使う） */
  authenticated?: boolean;
}

export interface WordpressClient {
  request(input: WordpressRequest): Promise<WordpressApiResponse>;
}

/**
 * 宛先の組み立て方（Q-052）。
 *
 * | | ベース | 例 |
 * |---|---|---|
 * | `pretty` | `.../wp-json` | `.../wp-json/wp/v2/posts?per_page=1` |
 * | `plain` | `.../index.php` | `.../index.php?rest_route=/wp/v2/posts&per_page=1` |
 *
 * **`plain` は書き換えを通らない。** パーマリンクが「基本」のサイトや
 * `.htaccess` が効いていないサイトでも届く。
 */
function buildRequestUrl(apiBaseUrl: string, path: string): string {
  if (restStyleOf(apiBaseUrl) === 'pretty') {
    return `${apiBaseUrl}${path}`;
  }

  // **`?` の前後を組み替える。** `path` に付いている問い合わせ文字列は
  // `rest_route` と**併記**しないと落ちる（`?` が2つになる）
  const separator = path.indexOf('?');
  const route = separator === -1 ? path : path.slice(0, separator);
  const rest = separator === -1 ? '' : path.slice(separator + 1);

  const query = new URLSearchParams(rest);
  // **`rest_route` を先頭に置く。** 読むときに人が分かりやすい
  const merged = new URLSearchParams({ rest_route: route });
  for (const [key, value] of query) {
    merged.append(key, value);
  }

  return `${apiBaseUrl}?${merged.toString()}`;
}

export interface WordpressClientOptions {
  apiBaseUrl: string;
  credentials: WordpressCredentials;
  /** 差し替え用。既定は `safeFetch` */
  fetchFn?: typeof safeFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Basic 認証ヘッダーを組み立てる。
 *
 * **戻り値を変数へ保持して持ち回らない。** リクエストのたびに作り、
 * ヘッダーへ入れて捨てる。
 */
function basicAuthHeader(credentials: WordpressCredentials): string {
  const raw = `${credentials.username.expose()}:${credentials.appPassword.expose()}`;

  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function parseJson(response: SafeFetchResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

/** WordPress REST API を叩くクライアントを作る */
export function createWordpressClient(
  options: WordpressClientOptions,
): WordpressClient {
  const fetchFn = options.fetchFn ?? safeFetch;
  const timeoutMs = options.timeoutMs ?? WORDPRESS_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? WORDPRESS_MAX_BYTES;

  return {
    async request(input) {
      const method = (input.method ?? 'GET').toUpperCase();
      const body =
        input.body === undefined ? undefined : JSON.stringify(input.body);

      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.authenticated === false
          ? {}
          : { authorization: basicAuthHeader(options.credentials) }),
      };

      const response = await fetchFn(
        buildRequestUrl(options.apiBaseUrl, input.path),
        {
          method,
          headers,
          body,
          timeoutMs,
          maxBytes,
          // JSON以外が返る場合は REST API ではない（WAFのブロック画面など）
          allowedContentTypes: JSON_CONTENT_TYPES,
        },
      );

      return {
        status: response.status,
        headers: response.headers,
        json: parseJson(response),
        raw: response.body,
      };
    },
  };
}

/** WordPress のエラー応答（`{ code, message, data: { status } }`） */
export interface WordpressErrorBody {
  code: string;
  message: string;
  status: number | undefined;
}

/**
 * WordPress のエラー応答を読み取る。形が違えば `null`。
 *
 * `rest_forbidden` `rest_cannot_create` のようなコードが入っており、
 * 権限不足の切り分けに使える（SPEC 7.2）。
 */
export function readWordpressError(json: unknown): WordpressErrorBody | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const record = json as Record<string, unknown>;
  if (
    typeof record['code'] !== 'string' ||
    typeof record['message'] !== 'string'
  ) {
    return null;
  }

  const data = record['data'];
  const status =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)['status']
      : undefined;

  return {
    code: record['code'],
    message: record['message'],
    status: typeof status === 'number' ? status : undefined,
  };
}

/**
 * `Allow` ヘッダーに指定のメソッドが含まれるか。
 *
 * WordPress は応答ごとに、**そのユーザーが使えるメソッド**を `Allow` で返す
 * （`rest_send_allow_header`）。実際に作成や更新をしなくても権限を判定できる。
 */
export function allowsMethod(
  headers: Record<string, string>,
  method: string,
): boolean | null {
  const allow = headers['allow'];
  if (allow === undefined) {
    return null;
  }

  return allow
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .includes(method.toUpperCase());
}
