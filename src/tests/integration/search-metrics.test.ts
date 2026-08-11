import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  enqueueSearchMetricsForUser,
  fetchSearchMetricsForUser,
  saveWeeklyResultForUser,
} from '@/modules/analytics';
import type { SearchAnalyticsQuery, SearchAnalyticsRow } from '@/lib/google';
import { claimNextJob } from '@/modules/jobs';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * Search Analytics の取り込みを**実PostgreSQLで**確かめる（TASKS G-2、SPEC 11.3）。
 *
 * 完了条件は「日次で表示回数・クリック・順位を保存。**API上限を考慮**」。
 *
 * ここで確かめる要点。
 *
 * - **ブログ全体をページの合計で代用しない**（重複と加重平均のため足せない）
 * - **自分の列だけ書く**（同じ行に手入力の成果が入っている・G-5）
 * - **何度動かしても同じ結果**（C-4）。遅れて確定した数字は上書きで入る
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

/** JST 2026-08-11 */
const NOW = new Date('2026-08-10T23:00:00.000Z');

const SITE = 'https://blog.example.com';

interface Recorded {
  dimensions: readonly string[];
  startDate: string;
  endDate: string;
}

let calls: Recorded[] = [];

/** 次元ごとに返す行を差し替えられる偽クライアント */
function client(rows: {
  date?: SearchAnalyticsRow[];
  page?: SearchAnalyticsRow[];
}) {
  return {
    query: (input: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]> => {
      calls.push({
        dimensions: input.dimensions,
        startDate: input.startDate,
        endDate: input.endDate,
      });

      return Promise.resolve(
        input.dimensions.includes('page')
          ? (rows.page ?? [])
          : (rows.date ?? []),
      );
    },
  };
}

function dateRow(
  date: string,
  values: { clicks: number; impressions: number; position: number },
): SearchAnalyticsRow {
  return { keys: [date], ...values };
}

function pageRow(
  date: string,
  page: string,
  values: { clicks: number; impressions: number; position: number },
): SearchAnalyticsRow {
  return { keys: [date, page], ...values };
}

async function connect(status = 'CONNECTED'): Promise<void> {
  await prisma.searchConsoleConnection.create({
    data: {
      blogId,
      propertyUrl: `${SITE}/`,
      connectionStatus: status as 'CONNECTED',
    },
  });
}

/** 投稿済みの記事を1件作り、そのURLを返す */
async function createPostedItem(url: string): Promise<string> {
  const plan =
    (await prisma.contentPlan.findFirst({
      where: { blogId },
      select: { id: true },
    })) ??
    (await prisma.contentPlan.create({
      data: {
        blogId,
        planType: 'INITIAL',
        status: 'DRAFT',
        strategySnapshot: {},
      },
      select: { id: true },
    }));

  const sequenceNo =
    (await prisma.contentItem.count({ where: { contentPlanId: plan.id } })) + 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo,
      contentType: 'AFFILIATE',
      title: '記事',
      searchIntent: '購入検討',
      objective: 'REVENUE',
      publishPriority: 1,
    },
    select: { id: true },
  });

  await prisma.wordpressPost.create({
    data: {
      blogId,
      contentItemId: item.id,
      wpPostId: 1000 + sequenceNo,
      wpPostUrl: url,
      lastContentHash: 'hash',
      postedAt: NOW,
    },
  });

  return item.id;
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  calls = [];

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, userId);
  blogId = blog.id;
});

describe('日次で表示回数・クリック・順位を保存する（完了条件）', () => {
  it('ブログ全体の行が日ごとに入る', async () => {
    await connect();

    const summary = await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          date: [
            dateRow('2026-08-09', {
              clicks: 3,
              impressions: 40,
              position: 8.25,
            }),
            dateRow('2026-08-10', {
              clicks: 5,
              impressions: 61,
              position: 7.5,
            }),
          ],
        }),
      },
    );

    expect(summary?.blogDays).toBe(2);

    const rows = await prisma.metricDaily.findMany({
      where: { blogId, contentItemId: null },
      orderBy: { metricDate: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      impressions: 61,
      searchClicks: 5,
    });
    expect(rows[1]?.averagePosition?.toString()).toBe('7.5');
  });

  it('記事ごとの行が入る', async () => {
    await connect();
    const itemId = await createPostedItem(`${SITE}/hello/`);

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          page: [
            pageRow('2026-08-10', `${SITE}/hello/`, {
              clicks: 2,
              impressions: 20,
              position: 4,
            }),
          ],
        }),
      },
    );

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId },
    });

    expect(row).toMatchObject({ impressions: 20, searchClicks: 2 });
  });

  /**
   * **末尾の `/` で取り逃さない。** WordPress のパーマリンクと
   * Search Console が返すURLは食い違うことがあり、揃えないと
   * 記事があるのに0件として並ぶ
   */
  it('末尾のスラッシュが違っても結びつく', async () => {
    await connect();
    const itemId = await createPostedItem(`${SITE}/hello/`);

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          page: [
            pageRow('2026-08-10', `${SITE}/hello`, {
              clicks: 1,
              impressions: 9,
              position: 3,
            }),
          ],
        }),
      },
    );

    expect(
      await prisma.metricDaily.count({ where: { contentItemId: itemId } }),
    ).toBe(1);
  });

  /** 結びつかないページは記事の行を作らない（数は返す） */
  it('知らないページは落として数える', async () => {
    await connect();

    const summary = await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          page: [
            pageRow('2026-08-10', `${SITE}/`, {
              clicks: 1,
              impressions: 9,
              position: 3,
            }),
            pageRow('2026-08-09', `${SITE}/`, {
              clicks: 1,
              impressions: 9,
              position: 3,
            }),
          ],
        }),
      },
    );

    expect(summary).toMatchObject({ articleRows: 0, unmatchedPages: 1 });
    expect(await prisma.metricDaily.count()).toBe(0);
  });
});

describe('ページの合計で全体を代用しない', () => {
  /**
   * **表示は重複して数えられ、平均掲載順位は加重平均なので足せない。**
   * 全体はGoogleに集計させた値をそのまま入れる
   */
  it('全体と記事別で別々に問い合わせる', async () => {
    await connect();

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      { client: client({}) },
    );

    expect(calls.map((call) => call.dimensions)).toEqual([
      ['date'],
      ['date', 'page'],
    ]);
  });

  it('全体の値はページの合計と一致しなくてよい', async () => {
    await connect();
    await createPostedItem(`${SITE}/hello/`);

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          date: [
            dateRow('2026-08-10', {
              clicks: 5,
              impressions: 50,
              position: 6,
            }),
          ],
          page: [
            pageRow('2026-08-10', `${SITE}/hello/`, {
              clicks: 9,
              impressions: 99,
              position: 2,
            }),
          ],
        }),
      },
    );

    const blogRow = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    // **ページの値で上書きされない**
    expect(blogRow).toMatchObject({ impressions: 50, searchClicks: 5 });
  });
});

describe('取り直しても壊れない', () => {
  /** **直近数日を毎回取り直す。** 遅れて確定した数字が上書きで入る */
  it('2回動かすと新しい値で上書きされる', async () => {
    await connect();

    const run = (impressions: number) =>
      fetchSearchMetricsForUser(
        { userId, blogId, now: NOW },
        {
          client: client({
            date: [
              dateRow('2026-08-10', { clicks: 1, impressions, position: 5 }),
            ],
          }),
        },
      );

    await run(10);
    await run(42);

    const rows = await prisma.metricDaily.findMany({
      where: { blogId, contentItemId: null },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.impressions).toBe(42);
  });

  /**
   * **同じ行に手入力の成果が入っている**（G-5）。行ごと置き換えない
   */
  it('手入力の成果を消さない', async () => {
    await connect();

    // JST 2026-08-10 は月曜。週次入力はその日の行に入る
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 3, revenueYen: 12_000 },
    );

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      {
        client: client({
          date: [
            dateRow('2026-08-10', { clicks: 1, impressions: 10, position: 5 }),
          ],
        }),
      },
    );

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    expect(row).toMatchObject({
      conversions: 3,
      revenueYen: 12_000,
      impressions: 10,
      searchClicks: 1,
    });
  });

  it('取り込めたら lastSyncedAt が入る', async () => {
    await connect();

    await fetchSearchMetricsForUser(
      { userId, blogId, now: NOW },
      { client: client({}) },
    );

    const connection = await prisma.searchConsoleConnection.findUnique({
      where: { blogId },
    });

    expect(connection?.lastSyncedAt).not.toBeNull();
    expect(connection?.lastErrorCode).toBeNull();
  });
});

describe('叩かないブログ', () => {
  /** **未連携・読めない状態は叩かない。** 呼び出しの上限を無駄に使う */
  it('未連携なら何もしない', async () => {
    expect(
      await fetchSearchMetricsForUser(
        { userId, blogId, now: NOW },
        { client: client({}) },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('読めない状態なら何もしない', async () => {
    await connect('FAILED');

    expect(
      await fetchSearchMetricsForUser(
        { userId, blogId, now: NOW },
        { client: client({}) },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('ジョブを積む', () => {
  /** **ブログごとに1件。** 1件で3ブログ回すと、失敗時に全部やり直す */
  it('連携済みのブログごとに1件積む', async () => {
    await connect();
    const second = await createBlog(prisma, userId, { slotNumber: 2 });
    await prisma.searchConsoleConnection.create({
      data: {
        blogId: second.id,
        propertyUrl: 'sc-domain:two.example.com',
        connectionStatus: 'CONNECTED',
      },
    });

    expect(await enqueueSearchMetricsForUser(userId, { now: NOW })).toBe(2);
  });

  /** **同じ日に何度呼んでも1回だけ**（冪等キーにJSTの日付） */
  it('同じ日に2回呼んでも増えない', async () => {
    await connect();

    await enqueueSearchMetricsForUser(userId, { now: NOW });

    expect(await enqueueSearchMetricsForUser(userId, { now: NOW })).toBe(0);
    expect(
      await prisma.job.count({ where: { jobType: 'SEARCH_CONSOLE_FETCH' } }),
    ).toBe(1);
  });

  /** **日が変われば取り直す。** 遅れて確定した数字が入る */
  it('翌日はまた積む', async () => {
    await connect();

    await enqueueSearchMetricsForUser(userId, { now: NOW });

    const tomorrow = new Date(NOW.getTime() + 86_400_000);

    expect(await enqueueSearchMetricsForUser(userId, { now: tomorrow })).toBe(
      1,
    );
  });

  it('連携していないブログのぶんは積まない', async () => {
    expect(await enqueueSearchMetricsForUser(userId, { now: NOW })).toBe(0);
  });

  it('読めない状態のブログのぶんは積まない', async () => {
    await connect('FAILED');

    expect(await enqueueSearchMetricsForUser(userId, { now: NOW })).toBe(0);
  });

  /** 閉じたブログは対象外（`alerts.ts` と同じ方針） */
  it('閉じたブログのぶんは積まない', async () => {
    await connect();
    await prisma.blog.update({
      where: { id: blogId },
      data: { status: 'CLOSED' },
    });

    expect(await enqueueSearchMetricsForUser(userId, { now: NOW })).toBe(0);
  });
});

/**
 * **積んだジョブが実際に取り出せて動くこと**（E-1・C-4）。
 *
 * 登録漏れは「積まれたまま `QUEUED` で残る」という形でしか現れず、
 * 気づきにくい。
 */
describe('ジョブとして動く', () => {
  it('積んだジョブを取り出して処理できる', async () => {
    await connect();
    await enqueueSearchMetricsForUser(userId, { now: NOW });

    // 連携を外しておく。**外部を叩かずにハンドラの登録と引数の読み取りを見る**
    await prisma.searchConsoleConnection.update({
      where: { blogId },
      data: { connectionStatus: 'FAILED' },
    });

    const job = await claimNextJob(['SEARCH_CONSOLE_FETCH']);

    if (job === null) {
      throw new Error('ジョブが積まれていない');
    }

    const handler = createJobHandlers()['SEARCH_CONSOLE_FETCH'];

    expect(handler).toBeDefined();
    expect(await handler?.(job)).toEqual({ skipped: true });
  });

  /** **入力からブログIDを取らない。** ジョブの列から取る（他人のブログを避ける） */
  it('blog_id の無いジョブは失敗する', async () => {
    const handler = createJobHandlers()['SEARCH_CONSOLE_FETCH'];

    await expect(
      handler?.({
        id: 'job',
        jobType: 'SEARCH_CONSOLE_FETCH',
        status: 'RUNNING',
        userId,
        blogId: null,
        targetId: null,
        input: {},
        attempts: 1,
        idempotencyKey: 'k',
      } as unknown as Parameters<NonNullable<typeof handler>>[0]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
