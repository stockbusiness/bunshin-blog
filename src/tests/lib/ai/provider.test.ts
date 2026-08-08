import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_ERROR_CODES, createAiProvider } from '@/lib/ai';

/**
 * AIプロバイダーの呼び出し（TASKS E-3）。
 *
 * **実HTTPサーバーに対して確かめる。** 偽の `fetch` は書いたとおりに
 * 動くだけで、「本当に想定の形で投げているか」を確かめられない。
 */

const ENV = {
  ANTHROPIC_API_KEY: 'sk-test-key',
  AI_PRICE_STANDARD_INPUT: '3',
  AI_PRICE_STANDARD_OUTPUT: '15',
};

let server: Server;
let baseUrl: string;

/** 受け取ったリクエストを記録する */
interface Received {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let received: Received[];
let respond: () => { status: number; body: string };

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }

      received.push({
        path: request.url ?? '/',
        method: request.method ?? 'GET',
        headers: request.headers,
        body,
      });

      const result = respond();
      response.writeHead(result.status, {
        'content-type': 'application/json',
      });
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

function okBody(text = 'こんにちは'): string {
  return JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1200, output_tokens: 800 },
  });
}

function provider(overrides: Record<string, string> = {}) {
  return createAiProvider({
    env: { ...ENV, ...overrides },
    baseUrl,
  });
}

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  received = [];
  respond = () => ({ status: 200, body: okBody() });
});

describe('リクエストの組み立て', () => {
  it('Messages API へ投げる', async () => {
    await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: '書いてください' }],
      maxOutputTokens: 1000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe('/v1/messages');
    expect(received[0]?.method).toBe('POST');
  });

  it('APIキーと版をヘッダーへ入れる', async () => {
    await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect(received[0]?.headers['x-api-key']).toBe('sk-test-key');
    expect(received[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  /** **完了条件。** 呼び出し側はモデル名を渡していない */
  it('用途からモデルが決まる', async () => {
    await provider({ AI_MODEL_STANDARD: 'my-standard-model' }).complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect((received[0]?.body as { model: string }).model).toBe(
      'my-standard-model',
    );
  });

  it('段が違えば別のモデルを使う', async () => {
    const ai = provider({
      AI_MODEL_LOW: 'low-model',
      AI_MODEL_HIGH: 'high-model',
    });

    await ai.complete({
      operation: 'CLASSIFY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });
    await ai.complete({
      operation: 'COMPARISON',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect((received[0]?.body as { model: string }).model).toBe('low-model');
    expect((received[1]?.body as { model: string }).model).toBe('high-model');
  });

  it('system と temperature は渡したときだけ入れる', async () => {
    await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });
    expect(received[0]?.body).not.toHaveProperty('system');
    expect(received[0]?.body).not.toHaveProperty('temperature');

    await provider().complete({
      operation: 'ARTICLE_BODY',
      system: '編集者として',
      temperature: 0.3,
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });
    expect((received[1]?.body as { system: string }).system).toBe(
      '編集者として',
    );
    expect((received[1]?.body as { temperature: number }).temperature).toBe(
      0.3,
    );
  });
});

describe('応答の読み取り', () => {
  it('本文とトークン数を返す', async () => {
    const result = await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect(result.text).toBe('こんにちは');
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(800);
    expect(result.provider).toBe('anthropic');
  });

  it('費用を計算する', async () => {
    const result = await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    // 1200/1e6*3 + 800/1e6*15
    expect(result.costUsd).toBeCloseTo(0.0036 + 0.012);
  });

  /** 単価が未設定なら null（0で埋めない） */
  it('単価が無ければ費用は null', async () => {
    const ai = createAiProvider({
      env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      baseUrl,
    });

    const result = await ai.complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect(result.costUsd).toBeNull();
  });

  /** `content` には `type: 'text'` 以外が混ざりうる */
  it('テキスト以外の要素を飛ばす', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'thinking', thinking: '内部の思考' },
          { type: 'text', text: '前半' },
          { type: 'text', text: '後半' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    const result = await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect(result.text).toBe('前半後半');
    expect(result.text).not.toContain('内部の思考');
  });

  it('usage が無ければ0として扱う', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'x' }] }),
    });

    const result = await provider().complete({
      operation: 'ARTICLE_BODY',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it.each([
    ['本文が無い', JSON.stringify({ content: [], usage: {} })],
    ['content が配列でない', JSON.stringify({ content: 'text' })],
    ['JSONでない', 'not json'],
  ])('%s なら失敗させる', async (_label, body) => {
    respond = () => ({ status: 200, body });

    await expect(
      provider().complete({
        operation: 'ARTICLE_BODY',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.invalidResponse });
  });
});

describe('失敗の扱い', () => {
  /** **応答本文をそのまま返さない。** 課金情報や内部の識別子が混ざりうる */
  it.each([[400], [401], [429], [500]])(
    'HTTP %s でエラーにし、本文を返さない',
    async (status) => {
      respond = () => ({
        status,
        body: JSON.stringify({
          error: { message: 'organization org_secret_123 のクレジットが不足' },
        }),
      });

      const error: unknown = await provider()
        .complete({
          operation: 'ARTICLE_BODY',
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 100,
        })
        .catch((caught: unknown) => caught);

      expect((error as { code: string }).code).toBe(
        AI_ERROR_CODES.requestFailed,
      );
      expect((error as { message: string }).message).not.toContain(
        'org_secret_123',
      );
    },
  );

  it('APIキーが無ければ呼びに行かない', async () => {
    const ai = createAiProvider({ env: {}, baseUrl });

    await expect(
      ai.complete({
        operation: 'ARTICLE_BODY',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.notConfigured });

    expect(received).toHaveLength(0);
  });

  /** **黙って別の作法で投げない** */
  it('未対応のプロバイダーでは呼びに行かない', async () => {
    const ai = createAiProvider({
      env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' },
      baseUrl,
    });

    await expect(
      ai.complete({
        operation: 'ARTICLE_BODY',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.notConfigured });

    expect(received).toHaveLength(0);
  });

  /** サーバーレスでは応答を待ち続けると関数ごと殺される（E-1） */
  it('時間内に応答しなければタイムアウトにする', async () => {
    const ai = createAiProvider({
      env: ENV,
      baseUrl,
      timeoutMs: 50,
      fetchFn: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as typeof fetch,
    });

    await expect(
      ai.complete({
        operation: 'ARTICLE_BODY',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.timeout });
  });

  it('接続できなければ到達不可にする', async () => {
    const ai = createAiProvider({
      env: ENV,
      // 閉じているポート
      baseUrl: 'http://127.0.0.1:1',
    });

    await expect(
      ai.complete({
        operation: 'ARTICLE_BODY',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
      }),
    ).rejects.toMatchObject({ code: AI_ERROR_CODES.unreachable });
  });
});
