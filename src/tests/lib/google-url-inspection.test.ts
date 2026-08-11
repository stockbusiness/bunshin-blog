import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  URL_INSPECTION_DAILY_QUOTA,
  UrlInspectionError,
  createUrlInspectionClient,
  toIndexVerdict,
} from '@/lib/google';
import { Secret } from '@/lib/crypto';

/**
 * URL Inspection を**実HTTPサーバー**で確かめる（TASKS G-3）。
 *
 * 要点は「**分からない」を `false` に倒さない**こと。
 * 倒すと「調べたが載っていない」と区別できず、
 * インデックス率（SPEC 11.2）が実際より低く出る。
 */

let server: Server;
let port: number;
let lastBody: Record<string, unknown> = {};

function indexResponse(verdict: string, coverageState?: string) {
  return {
    inspectionResult: {
      indexStatusResult: {
        verdict,
        ...(coverageState === undefined ? {} : { coverageState }),
      },
    },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = JSON.parse(
        Buffer.concat(chunks).toString('utf8') || '{}',
      ) as Record<string, unknown>;

      if (url.pathname.includes('quota')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      if (url.pathname.includes('down')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      if (url.pathname.includes('denied')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      if (url.pathname.includes('empty-result')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ inspectionResult: {} }));
        return;
      }

      if (url.pathname.includes('not-json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json');
        return;
      }

      if (url.pathname.includes('fail')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(indexResponse('FAIL', 'URL is unknown')));
        return;
      }

      if (url.pathname.includes('neutral')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(indexResponse('NEUTRAL')));
        return;
      }

      if (url.pathname.includes('partial')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(indexResponse('PARTIAL')));
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        'x-seen-authorization': req.headers.authorization ?? '',
      });
      res.end(JSON.stringify(indexResponse('PASS', 'Submitted and indexed')));
    });
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

function client(path = '/inspect') {
  return createUrlInspectionClient(
    {
      token: new Secret('access-token'),
      expiresAt: new Date(Date.now() + 1e6),
    },
    { endpoint: `http://127.0.0.1:${port}${path}` },
  );
}

const target = {
  propertyUrl: 'sc-domain:example.com',
  pageUrl: 'https://example.com/hello/',
};

describe('toIndexVerdict', () => {
  it('PASS は載っている', () => {
    expect(toIndexVerdict('PASS')).toBe('INDEXED');
  });

  it('FAIL は載っていない', () => {
    expect(toIndexVerdict('FAIL')).toBe('NOT_INDEXED');
  });

  /**
   * **断定できないものを断定しない。** 何が部分的なのかは
   * リッチリザルトなどの話で、索引の有無の根拠にならない
   */
  it.each(['PARTIAL', 'NEUTRAL', 'VERDICT_UNSPECIFIED', undefined, 42])(
    '%s は分からない',
    (value) => {
      expect(toIndexVerdict(value)).toBe('UNKNOWN');
    },
  );
});

describe('問い合わせ', () => {
  it('ページとプロパティを送る', async () => {
    await client().inspect(target);

    expect(lastBody).toEqual({
      inspectionUrl: target.pageUrl,
      siteUrl: target.propertyUrl,
    });
  });

  it('載っていれば INDEXED と説明が返る', async () => {
    expect(await client().inspect(target)).toEqual({
      verdict: 'INDEXED',
      coverageState: 'Submitted and indexed',
    });
  });

  it('載っていなければ NOT_INDEXED', async () => {
    expect(await client('/fail').inspect(target)).toMatchObject({
      verdict: 'NOT_INDEXED',
    });
  });

  it.each([
    { label: 'PARTIAL', path: '/partial' },
    { label: 'NEUTRAL', path: '/neutral' },
  ])('$label は UNKNOWN', async ({ path }) => {
    expect(await client(path).inspect(target)).toMatchObject({
      verdict: 'UNKNOWN',
    });
  });

  /** **読めない応答を「載っていない」にしない** */
  it.each([
    { label: '中身が空', path: '/empty-result' },
    { label: 'JSONでない', path: '/not-json' },
  ])('$label は UNKNOWN', async ({ path }) => {
    expect(await client(path).inspect(target)).toEqual({
      verdict: 'UNKNOWN',
      coverageState: null,
    });
  });
});

describe('取れないとき', () => {
  it.each([
    { label: '上限（429）', path: '/quota', retryable: true },
    { label: 'Googleが落ちている（500）', path: '/down', retryable: true },
    { label: '権限が無い（403）', path: '/denied', retryable: false },
  ])('$label の retryable は $retryable', async ({ path, retryable }) => {
    try {
      await client(path).inspect(target);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlInspectionError);
      expect((error as UrlInspectionError).retryable).toBe(retryable);
    }
  });

  it('届かなければ retryable', async () => {
    const unreachable = createUrlInspectionClient(
      { token: new Secret('t'), expiresAt: new Date(Date.now() + 1e6) },
      { endpoint: 'http://127.0.0.1:1/inspect' },
    );

    try {
      await unreachable.inspect(target);
      expect.unreachable();
    } catch (error) {
      expect((error as UrlInspectionError).retryable).toBe(true);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

/** **枠が Search Analytics と違う。** ここが別ジョブにする理由 */
describe('上限', () => {
  it('1日2,000回', () => {
    expect(URL_INSPECTION_DAILY_QUOTA).toBe(2_000);
  });
});
