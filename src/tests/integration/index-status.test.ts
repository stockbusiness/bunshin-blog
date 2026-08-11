import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  enqueueIndexStatusForUser,
  fetchIndexStatusForUser,
} from '@/modules/analytics';
import type { IndexVerdict, UrlInspectionClient } from '@/lib/google';
import { claimNextJob } from '@/modules/jobs';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * インデックス状況の取得を**実PostgreSQLで**確かめる（TASKS G-3、SPEC 11.3）。
 *
 * 完了条件は「**URL Inspection の結果が保存される**」。
 *
 * 要点は「**分からない」を `false` に倒さない**こと。倒すと
 * 「調べたが載っていない」と区別できず、インデックス率（SPEC 11.2）が
 * 実際より低く出る。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

/** JST 2026-08-11 */
const NOW = new Date('2026-08-10T23:00:00.000Z');

/**
 * `metric_date` に入る値。
 *
 * **JSTの暦日と一致する**（Q-031 を直したあと）。`jstDateColumn` が
 * UTCの真夜中を返すため、`date` 型の列にそのまま暦日が入る。
 */
const METRIC_DATE = new Date('2026-08-11T00:00:00.000Z');

const SITE = 'https://blog.example.com';

let inspected: string[] = [];

/** ページごとに判定を差し替えられる偽クライアント */
function client(
  verdicts: Record<string, IndexVerdict> = {},
  fallback: IndexVerdict = 'INDEXED',
): UrlInspectionClient {
  return {
    inspect: (input) => {
      inspected.push(input.pageUrl);

      return Promise.resolve({
        verdict: verdicts[input.pageUrl] ?? fallback,
        coverageState: null,
      });
    },
  };
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

let sequence = 0;

/** 投稿済みの記事を1件作る */
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

  sequence += 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: sequence,
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
      wpPostId: 1000 + sequence,
      wpPostUrl: url,
      lastContentHash: 'hash',
      postedAt: new Date(NOW.getTime() - sequence * 86_400_000),
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
  inspected = [];
  sequence = 0;

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, userId);
  blogId = blog.id;
});

describe('結果が保存される（完了条件）', () => {
  it('載っていれば indexed が true で入る', async () => {
    await connect();
    const itemId = await createPostedItem(`${SITE}/hello/`);

    const summary = await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );

    expect(summary).toMatchObject({ inspected: 1, indexed: 1, notIndexed: 0 });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId, metricDate: METRIC_DATE },
    });

    expect(row?.indexed).toBe(true);
  });

  it('載っていなければ false で入る', async () => {
    await connect();
    const itemId = await createPostedItem(`${SITE}/hello/`);

    await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client({}, 'NOT_INDEXED') },
    );

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId },
    });

    expect(row?.indexed).toBe(false);
  });

  /**
   * **`false` に倒さない。** 倒すと「調べたが載っていない」と区別できず、
   * インデックス率が実際より低く出る
   */
  it('分からなければ書かない', async () => {
    await connect();
    await createPostedItem(`${SITE}/hello/`);

    const summary = await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client({}, 'UNKNOWN') },
    );

    expect(summary).toMatchObject({ inspected: 1, unknown: 1 });
    expect(await prisma.metricDaily.count()).toBe(0);
  });

  /** **他の列に触らない。** 同じ行に検索データ（G-2）が入っている */
  it('既にある行の他の列を消さない', async () => {
    await connect();
    const itemId = await createPostedItem(`${SITE}/hello/`);

    await prisma.metricDaily.create({
      data: {
        blogId,
        contentItemId: itemId,
        metricDate: METRIC_DATE,
        impressions: 55,
        searchClicks: 4,
      },
    });

    await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId },
    });

    expect(row).toMatchObject({
      impressions: 55,
      searchClicks: 4,
      indexed: true,
    });
  });
});

describe('呼び出しの枠を無駄に使わない', () => {
  /** **今日ぶんが既にあるなら呼ばない**（C-4） */
  it('同じ日に2回動かしても1回しか呼ばない', async () => {
    await connect();
    await createPostedItem(`${SITE}/hello/`);

    await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );
    const second = await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );

    expect(inspected).toHaveLength(1);
    expect(second).toMatchObject({ inspected: 0 });
  });

  /** 日が変われば調べ直す（インデックスは後から付く） */
  it('翌日はまた調べる', async () => {
    await connect();
    await createPostedItem(`${SITE}/hello/`);

    await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );

    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const next = await fetchIndexStatusForUser(
      { userId, blogId, now: tomorrow },
      { client: client() },
    );

    expect(next).toMatchObject({ inspected: 1 });
    expect(await prisma.metricDaily.count()).toBe(2);
  });

  it('1回の実行で調べる本数に上限がある', async () => {
    await connect();
    await createPostedItem(`${SITE}/a/`);
    await createPostedItem(`${SITE}/b/`);
    await createPostedItem(`${SITE}/c/`);

    const summary = await fetchIndexStatusForUser(
      { userId, blogId, now: NOW, limit: 2 },
      { client: client() },
    );

    expect(summary).toMatchObject({ inspected: 2 });
    expect(inspected).toHaveLength(2);
  });

  /** **未連携・読めない状態は叩かない** */
  it.each([
    { label: '未連携', connect: false },
    { label: '読めない状態', connect: true },
  ])('$label なら何もしない', async ({ connect: shouldConnect }) => {
    if (shouldConnect) {
      await connect('FAILED');
    }

    await createPostedItem(`${SITE}/hello/`);

    expect(
      await fetchIndexStatusForUser(
        { userId, blogId, now: NOW },
        { client: client() },
      ),
    ).toBeNull();
    expect(inspected).toHaveLength(0);
  });

  it('投稿していない記事は調べない', async () => {
    await connect();

    const summary = await fetchIndexStatusForUser(
      { userId, blogId, now: NOW },
      { client: client() },
    );

    expect(summary).toMatchObject({ inspected: 0 });
  });
});

describe('別ジョブとして積む', () => {
  it('連携済みのブログごとに1件積む', async () => {
    await connect();

    expect(await enqueueIndexStatusForUser(userId, { now: NOW })).toBe(1);
  });

  /** **`SEARCH_CONSOLE_FETCH` とは別の行**（上限の枠が違う） */
  it('検索データの取得とは別の種類で積む', async () => {
    await connect();
    await enqueueIndexStatusForUser(userId, { now: NOW });

    const jobs = await prisma.job.findMany({ select: { jobType: true } });

    expect(jobs.map((job) => job.jobType)).toEqual(['URL_INSPECTION']);
  });

  it('同じ日に2回呼んでも増えない', async () => {
    await connect();
    await enqueueIndexStatusForUser(userId, { now: NOW });

    expect(await enqueueIndexStatusForUser(userId, { now: NOW })).toBe(0);
  });

  it('翌日はまた積む', async () => {
    await connect();
    await enqueueIndexStatusForUser(userId, { now: NOW });

    expect(
      await enqueueIndexStatusForUser(userId, {
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    ).toBe(1);
  });

  it('連携していないブログのぶんは積まない', async () => {
    expect(await enqueueIndexStatusForUser(userId, { now: NOW })).toBe(0);
  });

  it('積んだジョブを取り出して処理できる', async () => {
    await connect();
    await enqueueIndexStatusForUser(userId, { now: NOW });

    // 外部を叩かずにハンドラの登録と引数の読み取りを見る
    await prisma.searchConsoleConnection.update({
      where: { blogId },
      data: { connectionStatus: 'FAILED' },
    });

    const job = await claimNextJob(['URL_INSPECTION']);

    if (job === null) {
      throw new Error('ジョブが積まれていない');
    }

    const handler = createJobHandlers()['URL_INSPECTION'];

    expect(handler).toBeDefined();
    expect(await handler?.(job)).toEqual({ skipped: true });
  });
});
