import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  aggregateDailyMetricsForUser,
  enqueueDailyAggregateForUser,
  saveWeeklyResultForUser,
} from '@/modules/analytics';
import { claimNextJob } from '@/modules/jobs';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import { BLOG_ERROR_CODES } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * クリックの日次集計を**実PostgreSQLで**確かめる（TASKS G-6、SPEC 10.2）。
 *
 * **生イベント（`link_clicks`）を残したまま数え直す。** 何度動かしても
 * 同じ結果になり（C-4）、対象ドメインを足したあと（G-4）に
 * 数え直せば過去の日も正しくなる。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let offerId: string;

/** JST 2026-08-11 の朝 */
const NOW = new Date('2026-08-10T23:00:00.000Z');

/** JST 2026-08-11 の昼（同じJST暦日） */
const TODAY_CLICK = new Date('2026-08-11T03:00:00.000Z');

/** JST 2026-08-10 の夜（前日。UTCでは同じ日） */
const YESTERDAY_CLICK = new Date('2026-08-10T13:00:00.000Z');

let sequence = 0;

async function createItem(): Promise<string> {
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

  return item.id;
}

/** クリックを1件作る */
async function click(options: {
  contentItemId?: string | null;
  at?: Date;
  ai?: boolean;
}): Promise<void> {
  sequence += 1;

  const link = await prisma.affiliateLink.create({
    data: {
      code: `code-${sequence}-${Math.floor(Math.random() * 1e6)}`,
      affiliateOfferId: offerId,
      blogId,
      contentItemId: options.contentItemId ?? null,
      destinationUrl: 'https://asp.example.com/go',
    },
    select: { id: true },
  });

  await prisma.linkClick.create({
    data: {
      affiliateLinkId: link.id,
      clickedAt: options.at ?? TODAY_CLICK,
      isAiReferral: options.ai ?? false,
      referrerHost: options.ai === true ? 'chatgpt.com' : 'www.google.com',
    },
  });
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
  sequence = 0;

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, userId);
  blogId = blog.id;

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://asp.example.com/lp',
      affiliateUrl: 'https://asp.example.com/go',
      conversionType: 'PURCHASE',
      facts: {},
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  offerId = offer.id;
});

describe('アフィリエイトクリックを数える', () => {
  it('ブログ全体の行に入る', async () => {
    await click({});
    await click({});

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    expect(row?.affiliateClicks).toBe(2);
  });

  it('記事ごとの行にも入る', async () => {
    const itemId = await createItem();
    await click({ contentItemId: itemId });

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId },
    });

    expect(row?.affiliateClicks).toBe(1);
  });

  /**
   * **記事に紐づかないクリックも全体には数える。** 落とすと
   * 「記事の合計＝ブログ全体」に見えて、実際より少なく読める
   */
  it('記事に紐づかないクリックも全体には入る', async () => {
    const itemId = await createItem();
    await click({ contentItemId: itemId });
    await click({ contentItemId: null });

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const blogRow = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });
    const itemRow = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: itemId },
    });

    expect(blogRow?.affiliateClicks).toBe(2);
    expect(itemRow?.affiliateClicks).toBe(1);
  });

  /** **JSTの1日で切る。** UTCで切ると日本の夜が翌日に載る */
  it('JSTの暦日で分かれる', async () => {
    await click({ at: TODAY_CLICK });
    await click({ at: YESTERDAY_CLICK });

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const rows = await prisma.$queryRawUnsafe<
      { metric_date: string; affiliate_clicks: number }[]
    >(
      `select metric_date::text as metric_date, affiliate_clicks
       from metrics_daily where content_item_id is null order by metric_date`,
    );

    expect(rows).toEqual([
      { metric_date: '2026-08-10', affiliate_clicks: 1 },
      { metric_date: '2026-08-11', affiliate_clicks: 1 },
    ]);
  });
});

describe('AI検索経由を数える', () => {
  it('判別済みのクリックだけ数える（G-4）', async () => {
    await click({ ai: true });
    await click({ ai: false });

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    expect(row).toMatchObject({ affiliateClicks: 2, aiReferrals: 1 });
  });
});

describe('何度動かしても同じ', () => {
  it('2回動かしても増えない', async () => {
    await click({});

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });
    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const rows = await prisma.metricDaily.findMany({
      where: { blogId, contentItemId: null },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.affiliateClicks).toBe(1);
  });

  /** **あとから増えたぶんが入る**（その日の途中で動いた場合） */
  it('あとから増えたクリックが入る', async () => {
    await click({});
    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    await click({});
    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    expect(row?.affiliateClicks).toBe(2);
  });

  /** **触るのは自分の2列だけ。** 同じ行に他のタスクの値が入っている */
  it('検索データと手入力の成果を消さない', async () => {
    // JST 2026-08-10 は月曜。週次入力はその日の行に入る
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 3, revenueYen: 9_000 },
    );

    const existing = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
      select: { id: true },
    });

    await prisma.metricDaily.update({
      where: { id: existing?.id ?? '' },
      data: { impressions: 80, searchClicks: 7 },
    });

    await click({ at: YESTERDAY_CLICK });
    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({
      where: { blogId, contentItemId: null },
    });

    expect(row).toMatchObject({
      conversions: 3,
      revenueYen: 9_000,
      impressions: 80,
      searchClicks: 7,
      affiliateClicks: 1,
    });
  });
});

describe('空の行で埋めない', () => {
  /** クリックが一度も無いブログに、日付だけの行を作らない */
  it('クリックが無ければ行を作らない', async () => {
    const summary = await aggregateDailyMetricsForUser({
      userId,
      blogId,
      now: NOW,
    });

    expect(summary.written).toBe(0);
    expect(await prisma.metricDaily.count()).toBe(0);
  });

  /** **既にある行は0で更新する。** 「数えた結果0」を残す */
  it('既にある行は0で更新する', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 0, revenueYen: 0 },
    );

    await prisma.metricDaily.updateMany({
      where: { blogId },
      data: { affiliateClicks: 99 },
    });

    await aggregateDailyMetricsForUser({ userId, blogId, now: NOW });

    const row = await prisma.metricDaily.findFirst({ where: { blogId } });

    expect(row?.affiliateClicks).toBe(0);
  });
});

describe('他人のブログ', () => {
  it('集計を回せない', async () => {
    const other = await createUser(prisma);

    await expect(
      aggregateDailyMetricsForUser({ userId: other.id, blogId, now: NOW }),
    ).rejects.toMatchObject({ code: BLOG_ERROR_CODES.notFound });
  });
});

describe('ジョブとして動く', () => {
  it('ブログごとに1件積む', async () => {
    expect(await enqueueDailyAggregateForUser(userId, { now: NOW })).toBe(1);
  });

  it('同じ日に2回呼んでも増えない', async () => {
    await enqueueDailyAggregateForUser(userId, { now: NOW });

    expect(await enqueueDailyAggregateForUser(userId, { now: NOW })).toBe(0);
  });

  it('閉じたブログのぶんは積まない', async () => {
    await prisma.blog.update({
      where: { id: blogId },
      data: { status: 'CLOSED' },
    });

    expect(await enqueueDailyAggregateForUser(userId, { now: NOW })).toBe(0);
  });

  it('積んだジョブを取り出して処理できる', async () => {
    await click({});
    await enqueueDailyAggregateForUser(userId, { now: NOW });

    const job = await claimNextJob(['METRICS_AGGREGATE']);

    if (job === null) {
      throw new Error('ジョブが積まれていない');
    }

    const handler = createJobHandlers()['METRICS_AGGREGATE'];

    expect(handler).toBeDefined();
    expect(await handler?.(job)).toMatchObject({ blogId });
  });
});
