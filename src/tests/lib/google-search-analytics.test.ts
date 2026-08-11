import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEARCH_ANALYTICS_MAX_PAGES,
  SEARCH_ANALYTICS_MAX_ROWS,
  SearchAnalyticsError,
  createSearchAnalyticsClient,
} from '@/lib/google';
import { Secret } from '@/lib/crypto';

/**
 * Search Analytics の取得を**実HTTPサーバー**で確かめる（TASKS G-2）。
 *
 * 完了条件の「**API上限を考慮**」で効くのは行数の上限である。
 * 1回で返るのは最大25,000行で、それ以上は `startRow` で続きを取る。
 * **上限に満たなければそこで終わり**という判断を、実際の往復で確かめる。
 */

const PROPERTY = 'sc-domain:example.com';

/** 試験では小さくして、続きを取る動きを実際に起こす */
const ROW_LIMIT = 3;

let server: Server;
let port: number;

/** 直近の問い合わせの本文。何を送ったかを試験から見る */
let lastBody: Record<string, unknown> = {};
let requestCount = 0;

function row(page: number, index: number) {
  return {
    keys: ['2026-08-10', `https://example.com/p${page}-${index}/`],
    clicks: 1,
    impressions: 10,
    position: 5.5,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8') || '{}',
      );
      lastBody = (parsed ?? {}) as Record<string, unknown>;
      requestCount += 1;

      const startRow = Number(lastBody['startRow'] ?? 0);
      const limit = Number(lastBody['rowLimit'] ?? ROW_LIMIT);

      if (url.pathname.includes('paged')) {
        // 1ページ目は満杯、2ページ目は1行だけ（＝ここで終わり）
        const rows =
          startRow === 0
            ? Array.from({ length: limit }, (_, i) => row(1, i))
            : [row(2, 0)];

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows }));
        return;
      }

      if (url.pathname.includes('endless')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            rows: Array.from({ length: limit }, (_, i) => row(startRow, i)),
          }),
        );
        return;
      }

      if (url.pathname.includes('empty')) {
        // **`rows` を返さない。** 「その期間にデータが無い」は異常ではない
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      if (url.pathname.includes('broken-rows')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            rows: [
              row(1, 0),
              { keys: ['2026-08-10'], clicks: 'いくつか' },
              { nonsense: true },
            ],
          }),
        );
        return;
      }

      if (url.pathname.includes('not-json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json');
        return;
      }

      if (url.pathname.includes('rows-not-array')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows: { a: 1 } }));
        return;
      }

      if (url.pathname.includes('quota')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      if (url.pathname.includes('down')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      if (url.pathname.includes('denied')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rows: [row(1, 0)] }));
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

function client(path = '') {
  requestCount = 0;

  return createSearchAnalyticsClient(
    {
      token: new Secret('access-token'),
      expiresAt: new Date(Date.now() + 1e6),
    },
    { baseUrl: `http://127.0.0.1:${port}${path}`, rowLimit: ROW_LIMIT },
  );
}

const query = {
  propertyUrl: PROPERTY,
  startDate: '2026-08-06',
  endDate: '2026-08-10',
  dimensions: ['date', 'page'] as const,
};

describe('問い合わせの中身', () => {
  it('期間と次元をそのまま送る', async () => {
    await client().query(query);

    expect(lastBody).toMatchObject({
      startDate: '2026-08-06',
      endDate: '2026-08-10',
      dimensions: ['date', 'page'],
      rowLimit: ROW_LIMIT,
      startRow: 0,
    });
  });

  it('行を読み取って返す', async () => {
    const rows = await client().query(query);

    expect(rows).toEqual([
      {
        keys: ['2026-08-10', 'https://example.com/p1-0/'],
        clicks: 1,
        impressions: 10,
        position: 5.5,
      },
    ]);
  });
});

describe('続きを取る（API上限）', () => {
  /** **上限に満たなければそこで終わり。** 空の応答を待たない */
  it('満杯なら続きを取り、満たなければ止まる', async () => {
    const rows = await client('/paged').query(query);

    expect(rows).toHaveLength(ROW_LIMIT + 1);
    expect(requestCount).toBe(2);
  });

  it('2ページ目の startRow が1ページ目の行数ぶん進む', async () => {
    await client('/paged').query(query);

    expect(lastBody['startRow']).toBe(ROW_LIMIT);
  });

  /** **無限に回さない。** 歯止めに達したら打ち切る（記録は残す） */
  it('歯止めの回数で打ち切る', async () => {
    const rows = await client('/endless').query(query);

    expect(requestCount).toBe(SEARCH_ANALYTICS_MAX_PAGES);
    expect(rows).toHaveLength(SEARCH_ANALYTICS_MAX_PAGES * ROW_LIMIT);
  });

  it('既定の行数は Google の上限', () => {
    expect(SEARCH_ANALYTICS_MAX_ROWS).toBe(25_000);
  });
});

describe('取れないとき', () => {
  /** **データが無いのは異常ではない** */
  it('rows が無ければ空で返す', async () => {
    expect(await client('/empty').query(query)).toEqual([]);
  });

  /** **読めない行を0として数えない。** 落として先へ進む */
  it('読めない行は落とし、読める行は残す', async () => {
    const rows = await client('/broken-rows').query(query);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.clicks).toBe(1);
  });

  /**
   * **やり直して直るかを持つ。** 権限が無いなら何度やっても同じで、
   * 再試行はモニターに何も知らせないまま回数を消費する
   */
  it.each([
    { label: '上限（429）', path: '/quota', retryable: true },
    { label: 'Googleが落ちている（503）', path: '/down', retryable: true },
    { label: '権限が無い（403）', path: '/denied', retryable: false },
  ])('$label の retryable は $retryable', async ({ path, retryable }) => {
    try {
      await client(path).query(query);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SearchAnalyticsError);
      expect((error as SearchAnalyticsError).retryable).toBe(retryable);
    }
  });

  it('届かなければ retryable', async () => {
    const unreachable = createSearchAnalyticsClient(
      {
        token: new Secret('t'),
        expiresAt: new Date(Date.now() + 1e6),
      },
      { baseUrl: 'http://127.0.0.1:1' },
    );

    try {
      await unreachable.query(query);
      expect.unreachable();
    } catch (error) {
      expect((error as SearchAnalyticsError).retryable).toBe(true);
      // **原因を持ち回らない。** 本文にトークンが載りうる
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    { label: '応答がJSONでない', path: '/not-json' },
    { label: 'rows が配列でない', path: '/rows-not-array' },
  ])('$label は retryable でない', async ({ path }) => {
    try {
      await client(path).query(query);
      expect.unreachable();
    } catch (error) {
      expect((error as SearchAnalyticsError).retryable).toBe(false);
    }
  });
});
