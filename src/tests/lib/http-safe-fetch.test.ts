import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HTTP_ERROR_CODES,
  HttpFetchError,
  assertFetchableUrl,
  isHttpFetchError,
  resolveAllowedAddress,
  resolveRedirectTarget,
  safeFetch,
  type HostLookup,
  type HttpRawResponse,
  type HttpRequestInput,
  type HttpTransport,
} from '@/lib/http';

/**
 * 外向きHTTPの組み立て（TASKS C-7、SPEC 14.3）。
 *
 * 送信そのものは差し替える（`http-transport.test.ts` が実サーバーで確かめる）。
 * ここで確かめるのは**判定の順番と、転送のたびに検証をやり直すこと**。
 */

const PUBLIC_IP = '93.184.216.34';

/** ホスト名ごとに返すアドレスを決める */
function createLookup(map: Record<string, string[]>): HostLookup {
  return async (hostname) => {
    const addresses = map[hostname];
    if (addresses === undefined) {
      throw new Error(`解決できません: ${hostname}`);
    }

    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
}

interface RecordedTransport {
  transport: HttpTransport;
  calls: HttpRequestInput[];
}

/** 順番に応答を返す差し替え。呼ばれた内容を記録する */
function createTransport(
  responses: readonly Partial<HttpRawResponse>[],
): RecordedTransport {
  const calls: HttpRequestInput[] = [];
  let index = 0;

  return {
    calls,
    transport: async (input) => {
      calls.push(input);
      const response = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;

      return {
        status: response.status ?? 200,
        headers: response.headers ?? { 'content-type': 'application/json' },
        body: response.body ?? '{}',
      };
    },
  };
}

let lookup: HostLookup;

beforeEach(() => {
  lookup = createLookup({
    'example.com': [PUBLIC_IP],
    'other.example.com': ['93.184.216.35'],
    'internal.example.com': ['10.0.0.1'],
    'mixed.example.com': [PUBLIC_IP, '127.0.0.1'],
  });
});

describe('HttpFetchError', () => {
  it('自前のエラーだけを判別する', () => {
    expect(
      isHttpFetchError(
        new HttpFetchError(HTTP_ERROR_CODES.timeout, '応答がありませんでした'),
      ),
    ).toBe(true);
    expect(isHttpFetchError(new Error('別のエラー'))).toBe(false);
    expect(isHttpFetchError(null)).toBe(false);
  });

  it('補足はログ用に持ち、メッセージへは混ぜない', () => {
    const error = new HttpFetchError(
      HTTP_ERROR_CODES.blockedAddress,
      '到達できないアドレスです',
      { detail: 'internal.example.com -> 10.0.0.1' },
    );

    expect(error.message).not.toContain('10.0.0.1');
    expect(error.detail).toContain('10.0.0.1');
  });
});

describe('assertFetchableUrl', () => {
  it.each([
    ['https', 'https://example.com/wp-json'],
    ['http', 'http://example.com/'],
  ])('%s は通す', (_label, value) => {
    expect(assertFetchableUrl(value).hostname).toBe('example.com');
  });

  it.each([
    ['file', 'file:///etc/passwd', HTTP_ERROR_CODES.invalidUrl],
    ['ftp', 'ftp://example.com/', HTTP_ERROR_CODES.invalidUrl],
    ['gopher', 'gopher://example.com/', HTTP_ERROR_CODES.invalidUrl],
    [
      '資格情報つき',
      'https://user:pw@example.com/',
      HTTP_ERROR_CODES.invalidUrl,
    ],
    ['URLでない', 'not a url', HTTP_ERROR_CODES.invalidUrl],
  ])('拒否する（%s）', (_label, value, code) => {
    expect(() => assertFetchableUrl(value)).toThrow(HttpFetchError);
    try {
      assertFetchableUrl(value);
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect((error as HttpFetchError).code).toBe(code);
    }
  });
});

describe('resolveAllowedAddress', () => {
  it('公開アドレスなら固定する接続先を返す', async () => {
    const resolved = await resolveAllowedAddress('example.com', lookup);

    expect(resolved.address).toBe(PUBLIC_IP);
    expect(resolved.family).toBe(4);
  });

  it('内部アドレスへ解決されるホストを拒否する', async () => {
    await expect(
      resolveAllowedAddress('internal.example.com', lookup),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.blockedAddress });
  });

  // 先頭だけ見て通すと、公開IPと内部IPの両方を返すレコードで内部へ繋がる
  it('1件でも内部アドレスが混ざれば拒否する', async () => {
    await expect(
      resolveAllowedAddress('mixed.example.com', lookup),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.blockedAddress });
  });

  it('解決できないホストを拒否する', async () => {
    await expect(
      resolveAllowedAddress('missing.example.com', lookup),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.dnsFailed });
  });

  it('結果が空でも拒否する', async () => {
    await expect(
      resolveAllowedAddress('example.com', async () => []),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.dnsFailed });
  });

  it('拒否の理由に解決先を残す（ログ用）', async () => {
    try {
      await resolveAllowedAddress('internal.example.com', lookup);
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect((error as HttpFetchError).detail).toContain('10.0.0.1');
    }
  });
});

describe('resolveRedirectTarget', () => {
  const current = new URL('https://example.com/a/b');

  it('相対パスを絶対化する', () => {
    expect(resolveRedirectTarget(current, '/c').href).toBe(
      'https://example.com/c',
    );
  });

  it('絶対URLをそのまま使う', () => {
    expect(
      resolveRedirectTarget(current, 'https://other.example.com/').href,
    ).toBe('https://other.example.com/');
  });

  it('転送先にも同じ形式検証をかける', () => {
    expect(() => resolveRedirectTarget(current, 'file:///etc/passwd')).toThrow(
      HttpFetchError,
    );
  });
});

describe('safeFetch', () => {
  it('解決したIPを接続先として渡す', async () => {
    const { transport, calls } = createTransport([{}]);

    await safeFetch('https://example.com/wp-json', { lookup, transport });

    expect(calls[0]?.address).toBe(PUBLIC_IP);
    expect(calls[0]?.url.hostname).toBe('example.com');
  });

  it('Host ヘッダーはホスト名で送る（IPではない）', async () => {
    const { transport, calls } = createTransport([{}]);

    await safeFetch('https://example.com/wp-json', { lookup, transport });

    expect(calls[0]?.headers['host']).toBe('example.com');
  });

  it('応答を返す', async () => {
    const { transport } = createTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: '{"ok":true}',
      },
    ]);

    const response = await safeFetch('https://example.com/', {
      lookup,
      transport,
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    expect(response.body).toBe('{"ok":true}');
    expect(response.finalUrl).toBe('https://example.com/');
    expect(response.redirectCount).toBe(0);
  });

  it('内部アドレスへ解決されるURLは送信前に拒否する', async () => {
    const { transport, calls } = createTransport([{}]);

    await expect(
      safeFetch('https://internal.example.com/', { lookup, transport }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.blockedAddress });

    expect(calls).toHaveLength(0);
  });

  it('本文があれば content-length を付ける', async () => {
    const { transport, calls } = createTransport([{}]);

    await safeFetch('https://example.com/', {
      method: 'POST',
      body: '{"a":1}',
      lookup,
      transport,
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-length']).toBe('7');
  });

  it('メソッドを大文字にする', async () => {
    const { transport, calls } = createTransport([{}]);

    await safeFetch('https://example.com/', {
      method: 'post',
      lookup,
      transport,
    });

    expect(calls[0]?.method).toBe('POST');
  });

  it('タイムアウトと最大サイズを送信層へ渡す', async () => {
    const { transport, calls } = createTransport([{}]);

    await safeFetch('https://example.com/', {
      timeoutMs: 1234,
      maxBytes: 5678,
      lookup,
      transport,
    });

    expect(calls[0]?.timeoutMs).toBe(1234);
    expect(calls[0]?.maxBytes).toBe(5678);
  });
});

describe('safeFetch（転送）', () => {
  it('転送をたどる', async () => {
    const { transport, calls } = createTransport([
      { status: 302, headers: { location: 'https://other.example.com/next' } },
      { status: 200, headers: { 'content-type': 'text/html' }, body: 'ok' },
    ]);

    const response = await safeFetch('https://example.com/', {
      lookup,
      transport,
    });

    expect(response.finalUrl).toBe('https://other.example.com/next');
    expect(response.redirectCount).toBe(1);
    expect(calls).toHaveLength(2);
  });

  // 転送先を素通しすると、公開サイト経由で内部へ到達できる
  it('転送先が内部アドレスなら拒否する', async () => {
    const { transport, calls } = createTransport([
      { status: 302, headers: { location: 'https://internal.example.com/' } },
    ]);

    await expect(
      safeFetch('https://example.com/', { lookup, transport }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.blockedAddress });

    expect(calls).toHaveLength(1);
  });

  it('転送先が http/https 以外なら拒否する', async () => {
    const { transport } = createTransport([
      { status: 302, headers: { location: 'file:///etc/passwd' } },
    ]);

    await expect(
      safeFetch('https://example.com/', { lookup, transport }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.invalidUrl });
  });

  it('転送先の相対パスを絶対化して再検証する', async () => {
    const { transport, calls } = createTransport([
      { status: 301, headers: { location: '/moved' } },
      { status: 200 },
    ]);

    const response = await safeFetch('https://example.com/old', {
      lookup,
      transport,
    });

    expect(response.finalUrl).toBe('https://example.com/moved');
    expect(calls[1]?.url.pathname).toBe('/moved');
  });

  it('転送が多すぎれば止める', async () => {
    const { transport, calls } = createTransport([
      { status: 302, headers: { location: 'https://example.com/loop' } },
    ]);

    await expect(
      safeFetch('https://example.com/', {
        lookup,
        transport,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.tooManyRedirects });

    // 3回目で上限に達して止まる
    expect(calls).toHaveLength(3);
  });

  it('転送を許さない設定なら1回で止める', async () => {
    const { transport, calls } = createTransport([
      { status: 302, headers: { location: 'https://other.example.com/' } },
    ]);

    await expect(
      safeFetch('https://example.com/', {
        lookup,
        transport,
        maxRedirects: 0,
      }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.tooManyRedirects });

    expect(calls).toHaveLength(1);
  });

  it('303 は GET になり本文を落とす', async () => {
    const { transport, calls } = createTransport([
      { status: 303, headers: { location: 'https://example.com/done' } },
      { status: 200 },
    ]);

    await safeFetch('https://example.com/', {
      method: 'POST',
      body: '{"a":1}',
      lookup,
      transport,
    });

    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.body).toBeUndefined();
    expect(calls[1]?.headers['content-length']).toBeUndefined();
  });

  it('307 はメソッドと本文を保つ', async () => {
    const { transport, calls } = createTransport([
      { status: 307, headers: { location: 'https://example.com/again' } },
      { status: 200 },
    ]);

    await safeFetch('https://example.com/', {
      method: 'POST',
      body: '{"a":1}',
      lookup,
      transport,
    });

    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toBe('{"a":1}');
  });

  it('location の無い 3xx は転送として扱わない', async () => {
    const { transport } = createTransport([
      { status: 302, headers: { 'content-type': 'text/html' }, body: 'x' },
    ]);

    const response = await safeFetch('https://example.com/', {
      lookup,
      transport,
    });

    expect(response.status).toBe(302);
    expect(response.redirectCount).toBe(0);
  });
});

describe('safeFetch（Content-Type の確認）', () => {
  it('期待どおりなら通す', async () => {
    const { transport } = createTransport([
      { headers: { 'content-type': 'application/json' } },
    ]);

    await expect(
      safeFetch('https://example.com/', {
        lookup,
        transport,
        allowedContentTypes: ['application/json'],
      }),
    ).resolves.toMatchObject({ contentType: 'application/json' });
  });

  it('違えば本文を返さず例外にする', async () => {
    const { transport } = createTransport([
      { headers: { 'content-type': 'text/html' }, body: '<html>秘密</html>' },
    ]);

    await expect(
      safeFetch('https://example.com/', {
        lookup,
        transport,
        allowedContentTypes: ['application/json'],
      }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.unexpectedContentType });
  });

  it('Content-Type が無い場合も例外にする', async () => {
    const { transport } = createTransport([{ headers: {} }]);

    await expect(
      safeFetch('https://example.com/', {
        lookup,
        transport,
        allowedContentTypes: ['application/json'],
      }),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.unexpectedContentType });
  });

  it('指定しなければ確認しない', async () => {
    const { transport } = createTransport([
      { headers: { 'content-type': 'text/html' }, body: 'x' },
    ]);

    await expect(
      safeFetch('https://example.com/', { lookup, transport }),
    ).resolves.toMatchObject({ contentType: 'text/html', body: 'x' });
  });
});

describe('safeFetch（差し替えなしの実地確認）', () => {
  let server: Server;
  let port: number;
  let reached = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      reached += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('到達してしまった');
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
   * **名前解決も送信も差し替えずに確かめる。**
   *
   * `localhost` は実際に `127.0.0.1` へ解決される。差し替えテストは
   * 「判定表を正しく呼んでいるか」しか見ておらず、本番の名前解決を
   * 通したときに本当に止まるかは別の話。実際にサーバーを立てておき、
   * **1度も到達していないこと**を確かめる。
   */
  it('localhost へは到達しない', async () => {
    await expect(safeFetch(`http://localhost:${port}/`)).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.blockedAddress,
    });

    expect(reached).toBe(0);
  });

  it('IPを直接指定しても到達しない', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.blockedAddress,
    });

    expect(reached).toBe(0);
  });

  it('IPv6 のループバックを直接指定しても到達しない', async () => {
    await expect(safeFetch(`http://[::1]:${port}/`)).rejects.toMatchObject({
      code: HTTP_ERROR_CODES.blockedAddress,
    });

    expect(reached).toBe(0);
  });

  it('クラウドのメタデータへは到達しない', async () => {
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.blockedAddress });
  });

  it('解決できないホスト名は名前解決の失敗として返す', async () => {
    await expect(
      safeFetch('https://this-host-does-not-exist.invalid/'),
    ).rejects.toMatchObject({ code: HTTP_ERROR_CODES.dnsFailed });
  });
});
