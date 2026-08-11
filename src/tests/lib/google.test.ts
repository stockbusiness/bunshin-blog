import { createServer, type Server } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GoogleAuthError,
  GoogleServiceAccountInvalidError,
  SEARCH_CONSOLE_SCOPE,
  TOKEN_EXPIRY_MARGIN_MS,
  createSearchConsoleClient,
  fetchAccessToken,
  isPermissionLevel,
  isTokenExpired,
  parseServiceAccountKey,
  signAssertion,
} from '@/lib/google';
import { Secret } from '@/lib/crypto';

/**
 * サービスアカウント認証と Search Console の確認（TASKS G-1、Q-030）。
 *
 * **鍵は本物を生成し、署名は本当に検証する。** 「JWTらしい文字列が
 * 3つの部分に分かれている」ことを確かめても、Google が受け取るかは分からない。
 *
 * HTTP も**実サーバー**に対して確かめる（`wordpress/client.test.ts` と同じ）。
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const PRIVATE_KEY_PEM = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

const CLIENT_EMAIL = 'bunshin@example-project.iam.gserviceaccount.com';

function keyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_KEY_PEM,
    ...overrides,
  });
}

const NOW = new Date('2026-08-11T00:00:00Z');

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = new URLSearchParams(
          Buffer.concat(chunks).toString('utf8'),
        );

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `token-for-${body.get('grant_type')}`,
            expires_in: 3599,
            // **アサーションをそのまま返す。** 何が送られたかを試験から見る
            assertion: body.get('assertion'),
          }),
        );
      });
      return;
    }

    if (url.pathname === '/token-no-expiry') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'no-expiry' }));
      return;
    }

    if (url.pathname === '/token-empty') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ expires_in: 3600 }));
      return;
    }

    if (url.pathname === '/token-broken') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
      return;
    }

    if (url.pathname === '/token-denied') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }

    // Search Console
    if (url.pathname.startsWith('/sites/')) {
      const siteUrl = decodeURIComponent(url.pathname.slice('/sites/'.length));

      if (siteUrl === 'sc-domain:missing.example.com') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (siteUrl === 'sc-domain:forbidden.example.com') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forbidden' } }));
        return;
      }

      if (siteUrl === 'sc-domain:unverified.example.com') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ siteUrl, permissionLevel: 'siteUnverifiedUser' }),
        );
        return;
      }

      if (siteUrl === 'sc-domain:restricted.example.com') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ siteUrl, permissionLevel: 'siteRestrictedUser' }),
        );
        return;
      }

      if (siteUrl === 'sc-domain:broken.example.com') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ siteUrl, permissionLevel: 'まったく別の値' }));
        return;
      }

      if (siteUrl === 'sc-domain:down.example.com') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'oops' } }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        // 認証ヘッダーが届いているかを試験から見る
        'x-seen-authorization': req.headers.authorization ?? '',
      });
      res.end(JSON.stringify({ siteUrl, permissionLevel: 'siteOwner' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('サーバーのアドレスを取得できません');
  }

  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const tokenEndpoint = () => `http://127.0.0.1:${port}/token`;
const apiBase = () => `http://127.0.0.1:${port}`;

describe('parseServiceAccountKey', () => {
  it('client_email と private_key を取り出す', () => {
    const account = parseServiceAccountKey(keyJson());

    expect(account.clientEmail).toBe(CLIENT_EMAIL);
    expect(account.privateKey.expose()).toBe(PRIVATE_KEY_PEM);
  });

  it('前後の空白を落とす', () => {
    const account = parseServiceAccountKey(
      keyJson({ client_email: `  ${CLIENT_EMAIL}  ` }),
    );

    expect(account.clientEmail).toBe(CLIENT_EMAIL);
  });

  it('private_key は Secret に包まれ、そのままでは出ない', () => {
    const account = parseServiceAccountKey(keyJson());

    expect(`${account.privateKey}`).not.toContain('BEGIN');
    expect(JSON.stringify(account)).not.toContain('BEGIN');
  });

  it.each([
    { label: 'JSONでない', raw: 'not json' },
    { label: '配列', raw: '[]' },
    { label: 'null', raw: 'null' },
  ])('$label は弾く', ({ raw }) => {
    expect(() => parseServiceAccountKey(raw)).toThrow(
      GoogleServiceAccountInvalidError,
    );
  });

  it.each([
    { label: 'client_email が無い', overrides: { client_email: undefined } },
    { label: 'client_email が空', overrides: { client_email: '  ' } },
    { label: 'private_key が無い', overrides: { private_key: undefined } },
    { label: 'private_key が空', overrides: { private_key: '  ' } },
    { label: 'private_key がPEMでない', overrides: { private_key: 'abcdef' } },
  ])('$label は弾く', ({ overrides }) => {
    expect(() => parseServiceAccountKey(keyJson(overrides))).toThrow(
      GoogleServiceAccountInvalidError,
    );
  });

  /** **解析エラーの本文を持ち出さない**（SPEC 14.2） */
  it('エラーに鍵の中身を含めない', () => {
    try {
      parseServiceAccountKey(`{"private_key": "${PRIVATE_KEY_PEM}"`);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('BEGIN');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('signAssertion', () => {
  it('Google が検証できる署名を作る', () => {
    const account = parseServiceAccountKey(keyJson());
    const assertion = signAssertion({
      account,
      scope: SEARCH_CONSOLE_SCOPE,
      now: NOW,
    });

    const [header, claims, signature] = assertion.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);

    // **本物の公開鍵で検証する**
    expect(
      verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url')),
    ).toBe(true);
  });

  it('要求されたスコープと発行者を入れる', () => {
    const account = parseServiceAccountKey(keyJson());
    const assertion = signAssertion({
      account,
      scope: SEARCH_CONSOLE_SCOPE,
      now: NOW,
    });

    const claims: unknown = JSON.parse(
      Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );

    expect(claims).toMatchObject({
      iss: CLIENT_EMAIL,
      scope: SEARCH_CONSOLE_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
    });
  });

  /** **書き込みのスコープを要求しない。** 鍵が漏れても設定を変えられない */
  it('読み取りのスコープしか使わない', () => {
    expect(SEARCH_CONSOLE_SCOPE).toBe(
      'https://www.googleapis.com/auth/webmasters.readonly',
    );
  });
});

describe('fetchAccessToken', () => {
  it('JWTを引き換えてトークンを得る', async () => {
    const account = parseServiceAccountKey(keyJson());
    const token = await fetchAccessToken(account, {
      endpoint: tokenEndpoint(),
      now: NOW,
    });

    expect(token.token.expose()).toBe(
      'token-for-urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect(token.expiresAt).toEqual(new Date(NOW.getTime() + 3599 * 1000));
  });

  it('署名済みのアサーションを送っている', async () => {
    const account = parseServiceAccountKey(keyJson());
    let seen = '';

    await fetchAccessToken(account, {
      endpoint: tokenEndpoint(),
      now: NOW,
      fetchFn: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        const clone: unknown = await response.clone().json();
        seen =
          typeof clone === 'object' && clone !== null
            ? String((clone as Record<string, unknown>)['assertion'] ?? '')
            : '';
        return response;
      },
    });

    expect(seen.split('.')).toHaveLength(3);
  });

  /** **期限が返らなければ短く見積もる。** 失効を長く見積もらない */
  it('expires_in が無ければ5分にする', async () => {
    const account = parseServiceAccountKey(keyJson());
    const token = await fetchAccessToken(account, {
      endpoint: `${apiBase()}/token-no-expiry`,
      now: NOW,
    });

    expect(token.expiresAt).toEqual(new Date(NOW.getTime() + 300 * 1000));
  });

  it.each([
    { label: 'トークンが空', path: '/token-empty' },
    { label: '応答がJSONでない', path: '/token-broken' },
    { label: '拒否された', path: '/token-denied' },
  ])('$label なら GoogleAuthError', async ({ path }) => {
    const account = parseServiceAccountKey(keyJson());

    await expect(
      fetchAccessToken(account, { endpoint: `${apiBase()}${path}`, now: NOW }),
    ).rejects.toThrow(GoogleAuthError);
  });

  it('届かなければ GoogleAuthError（原因は持ち出さない）', async () => {
    const account = parseServiceAccountKey(keyJson());

    try {
      await fetchAccessToken(account, {
        endpoint: 'http://127.0.0.1:1/token',
        now: NOW,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleAuthError);
      // **アサーションが載りうる本文を持ち回らない**
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('isTokenExpired', () => {
  const token = {
    token: new Secret('t'),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
  };

  it('期限より十分手前なら有効', () => {
    expect(isTokenExpired(token, NOW)).toBe(false);
  });

  /** **ぎりぎりまで使わない。** 通信の途中で切れると原因が見分けにくい */
  it('余裕の内側に入ったら失効扱い', () => {
    const almost = new Date(
      token.expiresAt.getTime() - TOKEN_EXPIRY_MARGIN_MS + 1,
    );

    expect(isTokenExpired(token, almost)).toBe(true);
  });

  it('期限そのものでも失効扱い', () => {
    expect(isTokenExpired(token, token.expiresAt)).toBe(true);
  });
});

describe('createSearchConsoleClient', () => {
  const token = () => ({
    token: new Secret('access-token'),
    expiresAt: new Date(NOW.getTime() + 3600_000),
  });

  const client = () =>
    createSearchConsoleClient(token(), { baseUrl: apiBase() });

  it('読めるプロパティは権限つきで返る', async () => {
    const outcome = await client().getSite('sc-domain:ok.example.com');

    expect(outcome).toEqual({
      status: 'OK',
      permissionLevel: 'siteOwner',
    });
  });

  it('制限付きユーザーでも読めた扱いにする', async () => {
    const outcome = await client().getSite('sc-domain:restricted.example.com');

    expect(outcome).toEqual({
      status: 'OK',
      permissionLevel: 'siteRestrictedUser',
    });
  });

  it('アクセストークンを Bearer で送る', async () => {
    let seen = '';

    const custom = createSearchConsoleClient(token(), {
      baseUrl: apiBase(),
      fetchFn: async (input, init) => {
        const response = await globalThis.fetch(input, init);
        seen = response.headers.get('x-seen-authorization') ?? '';
        return response;
      },
    });

    await custom.getSite('sc-domain:ok.example.com');

    expect(seen).toBe('Bearer access-token');
  });

  it('プロパティのURLを符号化して渡す', async () => {
    const outcome = await client().getSite('https://blog.example.com/path/');

    expect(outcome).toEqual({ status: 'OK', permissionLevel: 'siteOwner' });
  });

  /**
   * **404 と 403 を同じに倒す。** どちらもモニターがすることは同じ
   * （アドレスを追加する／URLを直す）
   */
  it.each([
    { label: '404', property: 'sc-domain:missing.example.com' },
    { label: '403', property: 'sc-domain:forbidden.example.com' },
  ])('$label は NOT_FOUND', async ({ property }) => {
    expect(await client().getSite(property)).toEqual({ status: 'NOT_FOUND' });
  });

  /** **所有確認が済んでいないのは別**。モニターに頼むことが違う */
  it('siteUnverifiedUser は UNVERIFIED', async () => {
    expect(await client().getSite('sc-domain:unverified.example.com')).toEqual({
      status: 'UNVERIFIED',
      permissionLevel: 'siteUnverifiedUser',
    });
  });

  /** **落ちたことを「権限が無い」にしない**（H-3 と同じ筋） */
  it('5xx は UNAVAILABLE', async () => {
    expect(await client().getSite('sc-domain:down.example.com')).toEqual({
      status: 'UNAVAILABLE',
      httpStatus: 500,
    });
  });

  it('届かなければ UNAVAILABLE', async () => {
    const unreachable = createSearchConsoleClient(token(), {
      baseUrl: 'http://127.0.0.1:1',
    });

    expect(await unreachable.getSite('sc-domain:ok.example.com')).toEqual({
      status: 'UNAVAILABLE',
      httpStatus: null,
    });
  });

  /** 知らない権限の語を「読めた」に倒さない */
  it('知らない permissionLevel は UNAVAILABLE', async () => {
    expect(await client().getSite('sc-domain:broken.example.com')).toEqual({
      status: 'UNAVAILABLE',
      httpStatus: 200,
    });
  });
});

describe('isPermissionLevel', () => {
  it.each(['siteOwner', 'siteFullUser', 'siteRestrictedUser'])(
    '%s を認める',
    (value) => {
      expect(isPermissionLevel(value)).toBe(true);
    },
  );

  it.each([null, undefined, 42, 'owner', ''])('%s を認めない', (value) => {
    expect(isPermissionLevel(value)).toBe(false);
  });
});
