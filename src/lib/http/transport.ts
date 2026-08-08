/**
 * 実際にHTTPリクエストを出す層（TASKS C-7）。
 *
 * **`fetch` ではなく `node:http` / `node:https` を使う。** 接続先のIPを
 * 固定する（`lookup` を差し替える）必要があるため。`fetch` はホスト名で
 * 繋ぎ直すため、判定と接続の間にDNSの応答が変わると（DNSリバインディング）
 * 判定を通ったあとで内部アドレスへ繋がる。
 *
 * TLSの証明書検証は**ホスト名に対して**行われる。接続先IPだけを固定し、
 * `servername` は変えないため、証明書の確認はそのまま働く。
 *
 * ここは到達可否の判定を持たない。判定済みの宛先を受け取って送るだけ。
 * SSRF の判定は `url-guard.ts`、組み立ては `safe-fetch.ts`。
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { HTTP_ERROR_CODES, HttpFetchError } from './errors';

export interface HttpRequestInput {
  url: URL;
  /** 接続先として固定するIP。ホスト名では繋がない */
  address: string;
  family: number;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpRawResponse {
  status: number;
  headers: Record<string, string>;
  /** 本文。`maxBytes` を超えたら例外になるため、ここには収まっている */
  body: string;
}

export type HttpTransport = (
  input: HttpRequestInput,
) => Promise<HttpRawResponse>;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * 名前解決の代わりに、検証済みのアドレスをそのまま返す。
 *
 * **`node:net` は `all: true` で呼び、配列を期待する**（Node 22 で確認）。
 * 単一の形（`callback(err, address, family)`）で呼ばれる版もあるため、
 * 渡された `all` を見て両方に合わせる。ここを取り違えると
 * 「Invalid IP address: undefined」で接続そのものが失敗する。
 */
function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };
}

/** `node:http` / `node:https` で送る本番の実装 */
export const nodeHttpTransport: HttpTransport = (input) =>
  new Promise<HttpRawResponse>((resolve, reject) => {
    const secure = input.url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;

    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      action();
    };

    const req = send(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port:
          input.url.port === '' ? (secure ? 443 : 80) : Number(input.url.port),
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: input.headers,
        // 名前解決の結果を固定する。ここが DNS リバインディング対策の要
        lookup: pinnedLookup(input.address, input.family),
        // 転送は自前で扱う（転送先を毎回検証するため）
        ...(secure ? { servername: input.url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > input.maxBytes) {
            res.destroy();
            req.destroy();
            finish(() =>
              reject(
                new HttpFetchError(
                  HTTP_ERROR_CODES.tooLarge,
                  '応答が大きすぎます',
                  { detail: `${input.maxBytes} バイトを超えた` },
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            const normalized = headerValue(value);
            if (normalized !== undefined) {
              headers[name.toLowerCase()] = normalized;
            }
          }

          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });

        res.on('error', (error) => {
          finish(() =>
            reject(
              new HttpFetchError(
                HTTP_ERROR_CODES.requestFailed,
                '応答の受信に失敗しました',
                { cause: error },
              ),
            ),
          );
        });
      },
    );

    // 応答が来ないまま待ち続けない
    req.setTimeout(input.timeoutMs, () => {
      req.destroy();
      finish(() =>
        reject(
          new HttpFetchError(
            HTTP_ERROR_CODES.timeout,
            '応答がありませんでした',
            {
              detail: `${input.timeoutMs}ms`,
            },
          ),
        ),
      );
    });

    req.on('error', (error) => {
      finish(() =>
        reject(
          new HttpFetchError(
            HTTP_ERROR_CODES.requestFailed,
            '接続できませんでした',
            { cause: error },
          ),
        ),
      );
    });

    if (input.body !== undefined) {
      req.write(input.body);
    }
    req.end();
  });
