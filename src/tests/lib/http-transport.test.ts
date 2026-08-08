import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HTTP_ERROR_CODES,
  HttpFetchError,
  nodeHttpTransport,
} from '@/lib/http';

/**
 * 送信層を**実際のHTTPサーバーに対して**確かめる（TASKS C-7）。
 *
 * 差し替えでは、タイムアウト・最大サイズ・接続先の固定といった
 * 「実際にソケットを開いたときの挙動」を検証できない。
 *
 * ここでは `127.0.0.1` へ直接繋ぐ。**到達可否の判定は通っていない。**
 * SSRF の判定は `url-guard.ts` の担当で、送信層は判定済みの宛先を
 * 受け取って送るだけ、という分担を確かめるテストでもある。
 */

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
      return;
    }

    if (url.pathname === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }

    if (url.pathname === '/echo-body') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.concat(chunks).toString('utf8'));
      });
      return;
    }

    if (url.pathname === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // 少しずつ送る。受信側が途中で打ち切れることを確かめるため
      for (let index = 0; index < 100; index += 1) {
        res.write('x'.repeat(1024));
      }
      res.end();
      return;
    }

    if (url.pathname === '/slow') {
      // 応答を返さない。タイムアウトの確認用
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/json' });
      res.end();
      return;
    }

    if (url.pathname === '/multi-header') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['a=1', 'b=2'],
      });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
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

function input(path: string, overrides: Record<string, unknown> = {}) {
  return {
    url: new URL(`http://localhost:${port}${path}`),
    address: '127.0.0.1',
    family: 4,
    method: 'GET',
    headers: { host: `localhost:${port}` },
    body: undefined,
    timeoutMs: 2000,
    maxBytes: 1024 * 1024,
    ...overrides,
  } as Parameters<typeof nodeHttpTransport>[0];
}

describe('nodeHttpTransport', () => {
  it('応答を受け取れる', async () => {
    const response = await nodeHttpTransport(input('/json'));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({ ok: true, method: 'GET' });
  });

  // ホスト名ではなく渡したIPへ繋ぐ。DNSリバインディング対策の要
  it('渡したIPへ接続する（名前解決をやり直さない）', async () => {
    const response = await nodeHttpTransport(
      input('/json', {
        // 実在しないホスト名でも、固定したIPへ繋がる
        url: new URL(`http://this-host-does-not-exist.invalid:${port}/json`),
        headers: { host: `this-host-does-not-exist.invalid:${port}` },
      }),
    );

    expect(response.status).toBe(200);
  });

  it('Host ヘッダーをそのまま送る', async () => {
    const response = await nodeHttpTransport(
      input('/echo-headers', { headers: { host: 'example.com' } }),
    );

    expect(JSON.parse(response.body)['host']).toBe('example.com');
  });

  it('本文を送れる', async () => {
    const response = await nodeHttpTransport(
      input('/echo-body', {
        method: 'POST',
        body: '{"a":1}',
        headers: { host: `localhost:${port}`, 'content-length': '7' },
      }),
    );

    expect(response.body).toBe('{"a":1}');
  });

  it('ヘッダー名を小文字に揃える', async () => {
    const response = await nodeHttpTransport(input('/json'));

    expect(Object.keys(response.headers)).toContain('content-type');
  });

  it('同名ヘッダーが複数あればまとめる', async () => {
    const response = await nodeHttpTransport(input('/multi-header'));

    expect(response.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('転送は自前で扱う（自動でたどらない）', async () => {
    const response = await nodeHttpTransport(input('/redirect'));

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/json');
  });

  it('エラーの応答もそのまま返す', async () => {
    const response = await nodeHttpTransport(input('/missing'));

    expect(response.status).toBe(404);
    expect(response.body).toBe('not found');
  });

  it('最大サイズを超えたら打ち切る', async () => {
    await expect(
      nodeHttpTransport(input('/large', { maxBytes: 4096 })),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.tooLarge });
  });

  it('最大サイズに収まれば読み切る', async () => {
    const response = await nodeHttpTransport(
      input('/large', { maxBytes: 1024 * 1024 }),
    );

    expect(response.body).toHaveLength(100 * 1024);
  });

  it('応答が無ければタイムアウトする', async () => {
    await expect(
      nodeHttpTransport(input('/slow', { timeoutMs: 300 })),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.timeout });
  });

  it('繋がらなければ接続失敗として返す', async () => {
    await expect(
      nodeHttpTransport(
        input('/json', {
          // 使われていないポートへ向ける
          url: new URL('http://localhost:1/json'),
          headers: { host: 'localhost:1' },
        }),
      ),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.requestFailed });
  });

  it('失敗は HttpFetchError で返す', async () => {
    await expect(
      nodeHttpTransport(input('/slow', { timeoutMs: 200 })),
    ).rejects.toBeInstanceOf(HttpFetchError);
  });
});
