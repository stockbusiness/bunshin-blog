import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@/lib/crypto';
import {
  nodeHttpTransport,
  safeFetch,
  type SafeFetchOptions,
} from '@/lib/http';
import {
  allowsMethod,
  createWordpressClient,
  readWordpressError,
} from '@/modules/wordpress';

/**
 * WordPress クライアントを**実際のHTTPサーバー**に対して確かめる（C-2）。
 *
 * 差し替えでは、Basic 認証ヘッダーが実際にどう送られるかを検証できない。
 * WordPress を模したサーバーを立てて確かめる。
 *
 * SSRF の判定（`safeFetch`）は通さない。判定は
 * `src/tests/lib/http-safe-fetch.test.ts` が実サーバーで確かめており、
 * **クライアントが `safeFetch` へ何を渡すか**は本ファイル末尾で確かめる。
 */

const USERNAME = 'monitor01';
const APP_PASSWORD = 'abcdEFGHijklMNOPqrstUVWX';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/wp-json/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      res.end(
        JSON.stringify({
          method: req.method,
          authorization: req.headers.authorization ?? null,
          accept: req.headers.accept ?? null,
          contentType: req.headers['content-type'] ?? null,
        }),
      );
      return;
    }

    if (url.pathname === '/wp-json/echo-body') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.concat(chunks).toString('utf8') || 'null');
      });
      return;
    }

    if (url.pathname === '/wp-json/forbidden') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'rest_forbidden',
          message: '閲覧が許可されていません',
          data: { status: 403 },
        }),
      );
      return;
    }

    if (url.pathname === '/wp-json/allow') {
      res.writeHead(200, {
        'content-type': 'application/json',
        allow: 'GET, POST',
      });
      res.end('[]');
      return;
    }

    if (url.pathname === '/wp-json/broken-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{ これはJSONではない');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'rest_no_route', message: 'ルートが無い' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('テストサーバーのポートを取得できません');
  }
  port = address.port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/**
 * テスト用の送信。**`safeFetch` は使わない。**
 *
 * `safeFetch` はループバックへの到達を拒否する（C-7）。それは正しい挙動で、
 * `lookup` を差し替えても判定は結果のIPに対して働くため迂回できない。
 *
 * ここで見たいのは**クライアントの組み立て**（認証ヘッダー・本文・メソッド・
 * 応答の解釈）であり、SSRF の判定ではない。判定は
 * `src/tests/lib/http-safe-fetch.test.ts` が実サーバーで確かめている。
 * そこで送信層（`nodeHttpTransport`）を直接使う。
 *
 * **`safeFetch` へ何を渡しているか**は下の「safeFetch へ渡す設定」で確かめる。
 */
const localFetch: typeof safeFetch = async (target, options = {}) => {
  const url = new URL(String(target));
  const body = options.body;

  const raw = await nodeHttpTransport({
    url,
    address: '127.0.0.1',
    family: 4,
    method: (options.method ?? 'GET').toUpperCase(),
    headers: {
      host: url.host,
      ...options.headers,
      ...(body === undefined
        ? {}
        : { 'content-length': String(Buffer.byteLength(body, 'utf8')) }),
    },
    body,
    timeoutMs: options.timeoutMs ?? 5000,
    maxBytes: options.maxBytes ?? 1024 * 1024,
  });

  const contentType =
    raw.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? null;

  return {
    status: raw.status,
    headers: raw.headers,
    contentType,
    body: raw.body,
    finalUrl: url.href,
    redirectCount: 0,
  };
};

function createClient() {
  return createWordpressClient({
    apiBaseUrl: `http://localhost:${port}/wp-json`,
    credentials: {
      username: new Secret(USERNAME),
      appPassword: new Secret(APP_PASSWORD),
    },
    fetchFn: localFetch,
  });
}

describe('createWordpressClient', () => {
  it('Basic 認証ヘッダーを付ける', async () => {
    const response = await createClient().request({ path: '/echo' });
    const body = response.json as { authorization: string };

    const expected = `Basic ${Buffer.from(`${USERNAME}:${APP_PASSWORD}`).toString('base64')}`;
    expect(body.authorization).toBe(expected);
  });

  it('authenticated: false なら認証ヘッダーを付けない', async () => {
    const response = await createClient().request({
      path: '/echo',
      authenticated: false,
    });
    const body = response.json as { authorization: string | null };

    expect(body.authorization).toBeNull();
  });

  it('JSON を要求する', async () => {
    const response = await createClient().request({ path: '/echo' });
    const body = response.json as { accept: string };

    expect(body.accept).toBe('application/json');
  });

  it('本文を JSON で送る', async () => {
    const response = await createClient().request({
      path: '/echo-body',
      method: 'POST',
      body: { title: 'テスト', status: 'draft' },
    });

    expect(response.json).toEqual({ title: 'テスト', status: 'draft' });
  });

  it('本文があるときだけ content-type を付ける', async () => {
    const withoutBody = await createClient().request({ path: '/echo' });
    expect(
      (withoutBody.json as { contentType: string | null }).contentType,
    ).toBeNull();

    const withBody = await createClient().request({
      path: '/echo',
      method: 'POST',
      body: {},
    });
    expect((withBody.json as { contentType: string }).contentType).toBe(
      'application/json',
    );
  });

  it('メソッドを大文字にする', async () => {
    const response = await createClient().request({
      path: '/echo',
      method: 'delete',
    });

    expect((response.json as { method: string }).method).toBe('DELETE');
  });

  it('エラー応答もそのまま返す', async () => {
    const response = await createClient().request({ path: '/forbidden' });

    expect(response.status).toBe(403);
    expect(readWordpressError(response.json)).toEqual({
      code: 'rest_forbidden',
      message: '閲覧が許可されていません',
      status: 403,
    });
  });

  it('ヘッダーを読める', async () => {
    const response = await createClient().request({ path: '/allow' });

    expect(allowsMethod(response.headers, 'POST')).toBe(true);
    expect(allowsMethod(response.headers, 'DELETE')).toBe(false);
  });

  it('壊れた JSON は json: null にして生の本文を残す', async () => {
    const response = await createClient().request({ path: '/broken-json' });

    expect(response.json).toBeNull();
    expect(response.raw).toContain('これはJSONではない');
  });
});

describe('safeFetch へ渡す設定', () => {
  /**
   * 実際の SSRF 判定・転送の再検証・上限の適用は `safeFetch` の担当で、
   * `src/tests/lib/http-safe-fetch.test.ts` が確かめている。
   * ここでは**クライアントが正しい設定で呼んでいるか**だけを見る。
   */
  function createRecordingClient() {
    const calls: { url: string; options: SafeFetchOptions }[] = [];

    const fetchFn = (async (target, options = {}) => {
      calls.push({ url: String(target), options });

      return {
        status: 200,
        headers: {},
        contentType: 'application/json',
        body: '{}',
        finalUrl: String(target),
        redirectCount: 0,
      };
    }) as typeof safeFetch;

    return {
      calls,
      client: createWordpressClient({
        apiBaseUrl: 'https://monitor-blog.example.com/wp-json',
        credentials: {
          username: new Secret(USERNAME),
          appPassword: new Secret(APP_PASSWORD),
        },
        fetchFn,
      }),
    };
  }

  // WAF のブロック画面などを JSON として解釈しない（SPEC 14.3）
  it('JSON以外の応答を受け付けないよう指定する', async () => {
    const { client, calls } = createRecordingClient();

    await client.request({ path: '/wp/v2/posts' });

    expect(calls[0]?.options.allowedContentTypes).toEqual(['application/json']);
  });

  it('タイムアウトと最大サイズを指定する', async () => {
    const { client, calls } = createRecordingClient();

    await client.request({ path: '/wp/v2/posts' });

    expect(calls[0]?.options.timeoutMs).toBe(10_000);
    expect(calls[0]?.options.maxBytes).toBe(1024 * 1024);
  });

  it('apiBaseUrl とパスを繋げる', async () => {
    const { client, calls } = createRecordingClient();

    await client.request({ path: '/wp/v2/users/me?context=edit' });

    expect(calls[0]?.url).toBe(
      'https://monitor-blog.example.com/wp-json/wp/v2/users/me?context=edit',
    );
  });
});

describe('readWordpressError', () => {
  it.each([
    ['null', null],
    ['配列', []],
    ['code が無い', { message: 'x' }],
    ['message が無い', { code: 'x' }],
  ])('WordPress のエラーでなければ null（%s）', (_label, value) => {
    expect(readWordpressError(value)).toBeNull();
  });

  it('data.status が無くても読める', () => {
    expect(readWordpressError({ code: 'a', message: 'b' })).toEqual({
      code: 'a',
      message: 'b',
      status: undefined,
    });
  });
});

describe('allowsMethod', () => {
  it('Allow が無ければ null（判定できない）', () => {
    expect(allowsMethod({}, 'POST')).toBeNull();
  });

  it('空白と大文字小文字を無視する', () => {
    expect(allowsMethod({ allow: ' get , post ' }, 'POST')).toBe(true);
  });
});
