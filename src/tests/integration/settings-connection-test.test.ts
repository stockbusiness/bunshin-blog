import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resetEncryptionKeyCache } from '@/lib/crypto';
import {
  CONNECTION_TEST_CODES,
  saveSettingForAdmin,
  testConnectionForAdmin,
} from '@/modules/settings';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * 接続テスト（TASKS H-8、Q-017）を**実HTTPサーバー・実DBで**確かめる。
 *
 * 完了条件は2つ。
 *
 * 1. **保存前の値でも試せる**
 * 2. **応答本文を画面へ出さない**
 *
 * 偽の `fetch` では「本当に想定の形で投げているか」を確かめられない
 * （E-3 と同じ理由で実サーバーを立てる）。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;

interface Received {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

let received: Received[];
let respond: (path: string) => { status: number; body: string };

const ANTHROPIC_MODELS = JSON.stringify({
  data: [
    { type: 'model', id: 'claude-haiku-4-5-20251001' },
    { type: 'model', id: 'claude-sonnet-5' },
    { type: 'model', id: 'claude-opus-5' },
  ],
  has_more: false,
});

const RESEND_DOMAINS = JSON.stringify({
  data: [
    { id: 'd1', name: 'example.com', status: 'verified' },
    { id: 'd2', name: 'pending.example', status: 'pending' },
  ],
});

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = request.url ?? '/';

      received.push({
        path,
        method: request.method ?? 'GET',
        headers: request.headers,
      });

      const result = respond(path);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function urls() {
  return { anthropic: baseUrl, resend: baseUrl };
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServer();

  process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  resetEncryptionKeyCache();
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(async () => {
  await resetDatabase(prisma);
  received = [];
  respond = (path) => ({
    status: 200,
    body: path.startsWith('/domains') ? RESEND_DOMAINS : ANTHROPIC_MODELS,
  });
});

describe('AI（Anthropic）', () => {
  /** **これが完了条件。** 保存する前に確かめられる */
  it('保存前の値で試せる', async () => {
    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-typed-but-not-saved' },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(received[0]?.headers['x-api-key']).toBe(
      'sk-ant-typed-but-not-saved',
    );

    // **保存していない**
    expect(await prisma.appSetting.count()).toBe(0);
  });

  /** トークンを消費しない呼び出しを使う */
  it('モデル一覧を取りに行く（生成しない）', async () => {
    await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      baseUrls: urls(),
      env: {},
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.path).toMatch(/^\/v1\/models/);
    expect(received[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('保存済みの鍵でも試せる', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-saved-000000',
      actorUserId: null,
    });

    const result = await testConnectionForAdmin({
      target: 'AI',
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(received[0]?.headers['x-api-key']).toBe('sk-ant-saved-000000');
  });

  /** 伏せ字のまま送られても、保存済みの値を壊さない */
  it('空の上書きは無視する', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-saved-000000',
      actorUserId: null,
    });

    await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: '   ' },
      baseUrls: urls(),
      env: {},
    });

    expect(received[0]?.headers['x-api-key']).toBe('sk-ant-saved-000000');
  });

  it('鍵が無ければ呼びに行かない', async () => {
    const result = await testConnectionForAdmin({
      target: 'AI',
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONNECTION_TEST_CODES.notConfigured);
    expect(received).toHaveLength(0);
  });

  /**
   * **モデル名の打ち間違いをここで捕まえる。** 鍵が通っても
   * モデル名が違えば記事は生成できず、実際に生成するまで分からない。
   */
  it('設定したモデルが無ければ失敗にする', async () => {
    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: {
        ANTHROPIC_API_KEY: 'sk-ant-0123456789',
        AI_MODEL_STANDARD: 'claude-sonnet-99',
      },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONNECTION_TEST_CODES.notFound);
    expect(result.message).toContain('claude-sonnet-99');
  });

  /**
   * **全件見ていないのに「無い」と言わない。** 正しい設定を疑わせる
   */
  it('一覧を取り切れていなければモデル名を照合しない', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        data: [{ type: 'model', id: 'something-else' }],
        has_more: true,
      }),
    });

    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(true);
  });
});

describe('メール（Resend）', () => {
  it('ドメイン一覧を取りに行く（送らない）', async () => {
    const result = await testConnectionForAdmin({
      target: 'MAIL',
      overrides: {
        RESEND_API_KEY: 're_0123456789',
        MAIL_FROM: 'noreply@example.com',
      },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.path).toBe('/domains');
    expect(received[0]?.headers['authorization']).toBe('Bearer re_0123456789');
  });

  /**
   * **B-11 の残課題をここで見えるようにする。** 未認証のドメインからは
   * 送れず、管理者ログインのリンクが届かない。
   */
  it('送信元が認証済みドメインでなければ失敗にする', async () => {
    const result = await testConnectionForAdmin({
      target: 'MAIL',
      overrides: {
        RESEND_API_KEY: 're_0123456789',
        MAIL_FROM: 'noreply@pending.example',
      },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONNECTION_TEST_CODES.notFound);
    expect(result.message).toContain('pending.example');
  });

  it('足りない設定の名前を伝える', async () => {
    const result = await testConnectionForAdmin({
      target: 'MAIL',
      overrides: { RESEND_API_KEY: 're_0123456789' },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CONNECTION_TEST_CODES.notConfigured);
    expect(result.message).toContain('MAIL_FROM');
    expect(received).toHaveLength(0);
  });
});

describe('失敗の扱い', () => {
  /** **応答本文を画面へ出さない。** 課金情報や内部の識別子が混ざりうる */
  it.each([
    [401, CONNECTION_TEST_CODES.unauthorized],
    [403, CONNECTION_TEST_CODES.unauthorized],
    [429, CONNECTION_TEST_CODES.rateLimited],
    [500, CONNECTION_TEST_CODES.providerError],
  ])('HTTP %s を種別へ移し、本文を返さない', async (status, code) => {
    respond = () => ({
      status,
      body: JSON.stringify({
        error: { message: 'organization org_secret_123 のクレジットが不足' },
      }),
    });

    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      baseUrls: urls(),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('org_secret_123');
  });

  it('応答が読めなければ失敗にする', async () => {
    respond = () => ({ status: 200, body: 'not json' });

    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      baseUrls: urls(),
      env: {},
    });

    expect(result.code).toBe(CONNECTION_TEST_CODES.invalidResponse);
  });

  it('繋がらなければ到達不可にする', async () => {
    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      // 閉じているポート
      baseUrls: { anthropic: 'http://127.0.0.1:1' },
      env: {},
    });

    expect(result.code).toBe(CONNECTION_TEST_CODES.unreachable);
  });

  it('時間内に応答しなければタイムアウトにする', async () => {
    const result = await testConnectionForAdmin({
      target: 'AI',
      overrides: { ANTHROPIC_API_KEY: 'sk-ant-0123456789' },
      baseUrls: urls(),
      timeoutMs: 30,
      fetchFn: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as typeof fetch,
      env: {},
    });

    expect(result.code).toBe(CONNECTION_TEST_CODES.timeout);
  });

  /**
   * **一覧にない名前を重ねさせない。** 重ねられると、設定できない
   * 環境変数を差し替えて外部を呼ばせられる
   */
  it('設定できない名前を上書きに使えない', async () => {
    await expect(
      testConnectionForAdmin({
        target: 'AI',
        overrides: { DATABASE_URL: 'postgres://attacker' },
        baseUrls: urls(),
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'SETTING_UNKNOWN_KEY' });

    expect(received).toHaveLength(0);
  });
});
