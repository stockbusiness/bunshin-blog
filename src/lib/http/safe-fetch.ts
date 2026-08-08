/**
 * 外向きHTTPの共通クライアント（TASKS C-7、SPEC 14.3）。
 *
 * **利用者が宛先を決められるリクエストは必ずここを通す。**
 * 対象は C-2（WordPress接続テスト）と D-2（LP自動評価）。
 *
 * 接続先の固定された外部API（LINE・Resend）はここを通さない。
 * 宛先を利用者が決められないため SSRF の対象ではなく、通しても
 * 名前解決のぶん遅くなるだけで得るものが無い。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { HTTP_ERROR_CODES, HttpFetchError } from './errors';
import { nodeHttpTransport, type HttpTransport } from './transport';
import {
  assertFetchableUrl,
  resolveAllowedAddress,
  resolveRedirectTarget,
  type HostLookup,
} from './url-guard';

/** 既定のタイムアウト。モニターを待たせすぎない */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 既定の最大レスポンスサイズ。WordPress の投稿一覧を読むには十分 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 既定の最大転送回数。`http → https` と正規化で2回程度は普通に起きる */
export const DEFAULT_MAX_REDIRECTS = 3;

/** 転送とみなすステータス */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | undefined;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * 期待する Content-Type（`;` より前の部分）。
   * 指定すると、一致しない応答は本文を返さず例外にする（SPEC 14.3）。
   */
  allowedContentTypes?: readonly string[] | undefined;
  /** 差し替え用。既定は `node:dns` */
  lookup?: HostLookup | undefined;
  /** 差し替え用。既定は `node:http` / `node:https` */
  transport?: HttpTransport | undefined;
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  /** `;` より前だけを取り出した Content-Type。無ければ `null` */
  contentType: string | null;
  body: string;
  /** 転送をたどった最終的なURL */
  finalUrl: string;
  /** たどった転送の回数 */
  redirectCount: number;
}

const defaultLookup: HostLookup = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });

  return entries.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
};

function parseContentType(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const type = value.split(';')[0]?.trim().toLowerCase() ?? '';

  return type === '' ? null : type;
}

/**
 * 転送後にメソッドと本文をどう扱うか。
 *
 * 303 は必ず GET になり、301・302 も実務上 GET へ落とすのが慣例。
 * 307・308 は元のメソッドと本文を保つ。
 */
function nextRequest(
  status: number,
  method: string,
  body: string | undefined,
): { method: string; body: string | undefined } {
  if (status === 307 || status === 308) {
    return { method, body };
  }

  if (method === 'GET' || method === 'HEAD') {
    return { method, body: undefined };
  }

  return { method: 'GET', body: undefined };
}

/**
 * SSRF対策を通したうえでHTTPリクエストを出す。
 *
 * 毎回の転送で次を行う。
 *
 * 1. URLの形式を確かめる（http/https のみ、資格情報つきを拒否）
 * 2. **名前解決した結果の全アドレス**が到達可能かを確かめる
 * 3. **解決したIPを固定して**接続する（DNSリバインディング対策）
 * 4. タイムアウトと最大サイズを強制する
 *
 * @throws {HttpFetchError} 上記のいずれかに引っかかった場合
 */
export async function safeFetch(
  target: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const lookup = options.lookup ?? defaultLookup;
  const transport = options.transport ?? nodeHttpTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let url = assertFetchableUrl(target);
  let method = (options.method ?? 'GET').toUpperCase();
  let body = options.body;
  let redirectCount = 0;

  // 転送のたびに検証をやり直す。`while (true)` にせず上限で必ず抜ける
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const resolved = await resolveAllowedAddress(url.hostname, lookup);

    const headers: Record<string, string> = {
      // Host は接続先IPではなくホスト名で送る（仮想ホストと証明書のため）
      host: url.host,
      'accept-encoding': 'identity',
      ...options.headers,
      ...(body === undefined
        ? {}
        : { 'content-length': String(Buffer.byteLength(body, 'utf8')) }),
    };

    const response = await transport({
      url,
      address: resolved.address,
      family: resolved.family,
      method,
      headers,
      body,
      timeoutMs,
      maxBytes,
    });

    const location = response.headers['location'];
    if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
      if (attempt === maxRedirects) {
        throw new HttpFetchError(
          HTTP_ERROR_CODES.tooManyRedirects,
          '転送が多すぎます',
          { detail: `${maxRedirects} 回を超えた` },
        );
      }

      // ここで最初と同じ形式検証を通す。転送先を素通しすると対策が無効になる
      url = resolveRedirectTarget(url, location);
      ({ method, body } = nextRequest(response.status, method, body));
      redirectCount += 1;
      continue;
    }

    const contentType = parseContentType(response.headers['content-type']);

    if (
      options.allowedContentTypes !== undefined &&
      (contentType === null ||
        !options.allowedContentTypes.includes(contentType))
    ) {
      throw new HttpFetchError(
        HTTP_ERROR_CODES.unexpectedContentType,
        '応答の種類が想定と違います',
        { detail: contentType ?? '（Content-Type なし）' },
      );
    }

    return {
      status: response.status,
      headers: response.headers,
      contentType,
      body: response.body,
      finalUrl: url.href,
      redirectCount,
    };
  }

  // 上のループは必ず return か throw で抜ける
  throw new HttpFetchError(
    HTTP_ERROR_CODES.tooManyRedirects,
    '転送が多すぎます',
    { detail: `${maxRedirects} 回を超えた` },
  );
}
