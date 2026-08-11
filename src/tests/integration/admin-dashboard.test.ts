import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { aggregateForAdmin } from '@/app/admin/(protected)/dashboard/_lib/aggregate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 実験の集計を**実PostgreSQLで**確かめる（TASKS G-7、SPEC 10.3）。
 *
 * 完了条件は「**ジャンル別・戦略別・ブログ別の集計がSQLで取得できる**」。
 *
 * ここで確かめる要点。
 *
 * - **同じ数を二重に数えない**（記事ごとの行とブログ全体の行）
 * - **AI費用と指標を掛け算しない**（別々に集めてから結合する）
 * - **未設定を隠さない**（ジャンルや戦略が付いていないブログ）
 */

let prisma: PrismaClient;

const METRIC_DATE = new Date('2026-08-10T00:00:00.000Z');

async function setup(): Promise<{
  userId: string;
  blogId: string;
  contentItemId: string;
}> {
  const user = await createUser(prisma);
  const blog = await createBlog(prisma, user.id);

  const plan = await prisma.contentPlan.create({
    data: {
      blogId: blog.id,
      planType: 'INITIAL',
      status: 'DRAFT',
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: blog.id,
      sequenceNo: 1,
      contentType: 'AFFILIATE',
      title: '記事',
      searchIntent: '購入検討',
      objective: 'REVENUE',
      publishPriority: 1,
    },
    select: { id: true },
  });

  return { userId: user.id, blogId: blog.id, contentItemId: item.id };
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
});

describe('ブログ別', () => {
  it('ブログ全体の行を足す', async () => {
    const { blogId } = await setup();

    await prisma.metricDaily.createMany({
      data: [
        {
          blogId,
          metricDate: METRIC_DATE,
          impressions: 100,
          searchClicks: 10,
          affiliateClicks: 3,
          aiReferrals: 1,
          conversions: 2,
          revenueYen: 5_000,
        },
        {
          blogId,
          metricDate: new Date('2026-08-11T00:00:00.000Z'),
          impressions: 50,
          searchClicks: 5,
          affiliateClicks: 1,
          aiReferrals: 0,
          conversions: 1,
          revenueYen: 2_000,
        },
      ],
    });

    const rows = await aggregateForAdmin('BLOG');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      blogs: 1,
      impressions: 150,
      searchClicks: 15,
      affiliateClicks: 4,
      aiReferrals: 1,
      conversions: 3,
      revenueYen: 7_000,
    });
  });

  /**
   * **記事ごとの行を足さない。** 足すと同じクリックを二重に数える
   */
  it('記事ごとの行は足さない', async () => {
    const { blogId, contentItemId } = await setup();

    await prisma.metricDaily.createMany({
      data: [
        { blogId, metricDate: METRIC_DATE, affiliateClicks: 5 },
        {
          blogId,
          contentItemId,
          metricDate: METRIC_DATE,
          affiliateClicks: 5,
        },
      ],
    });

    const rows = await aggregateForAdmin('BLOG');

    expect(rows[0]?.affiliateClicks).toBe(5);
  });

  /** **数と費用を掛け算しない。** 別々に集めてから結合する */
  it('AI費用が指標の行数だけ膨らまない', async () => {
    const { userId, blogId } = await setup();

    await prisma.metricDaily.createMany({
      data: [
        { blogId, metricDate: METRIC_DATE, impressions: 10 },
        {
          blogId,
          metricDate: new Date('2026-08-11T00:00:00.000Z'),
          impressions: 10,
        },
      ],
    });

    await prisma.aiUsageLog.create({
      data: {
        userId,
        blogId,
        provider: 'anthropic',
        model: 'claude',
        operation: 'ARTICLE',
        inputTokens: 100,
        outputTokens: 200,
        costUsd: '1.50',
      },
    });

    const rows = await aggregateForAdmin('BLOG');

    expect(rows[0]).toMatchObject({ impressions: 20, aiCostUsd: 1.5 });
  });

  it('公開済みの記事数を数える', async () => {
    const { blogId, contentItemId } = await setup();

    await prisma.wordpressPost.create({
      data: {
        blogId,
        contentItemId,
        wpPostId: 1,
        lastContentHash: 'hash',
        postedAt: METRIC_DATE,
      },
    });

    const rows = await aggregateForAdmin('BLOG');

    expect(rows[0]?.postedArticles).toBe(1);
  });

  /** データが1行も無くても、ブログは並ぶ（0として見える） */
  it('計測がまだ無いブログも並ぶ', async () => {
    await setup();

    const rows = await aggregateForAdmin('BLOG');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ impressions: 0, revenueYen: 0 });
  });

  /** **閉じたブログも数える。** 途中でやめたことも実験の結果（H-4） */
  it('閉じたブログも並ぶ', async () => {
    const { blogId } = await setup();
    await prisma.blog.update({
      where: { id: blogId },
      data: { status: 'CLOSED' },
    });

    expect(await aggregateForAdmin('BLOG')).toHaveLength(1);
  });
});

describe('ジャンル別', () => {
  it('同じジャンルのブログをまとめる', async () => {
    const genre = await prisma.genre.create({
      data: { name: '節約', category: '生活', ymylRisk: 'LOW' },
      select: { id: true },
    });

    const first = await setup();
    const second = await setup();

    await prisma.blog.updateMany({
      where: { id: { in: [first.blogId, second.blogId] } },
      data: { genreId: genre.id },
    });

    await prisma.metricDaily.createMany({
      data: [
        { blogId: first.blogId, metricDate: METRIC_DATE, revenueYen: 1_000 },
        { blogId: second.blogId, metricDate: METRIC_DATE, revenueYen: 2_000 },
      ],
    });

    const rows = await aggregateForAdmin('GENRE');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: '節約',
      blogs: 2,
      revenueYen: 3_000,
    });
  });

  /**
   * **未設定を「その他」に混ぜない。** 付いていないこと自体が
   * 運営の直すべき状態である
   */
  it('ジャンル未設定は（未設定）として並ぶ', async () => {
    await setup();

    const rows = await aggregateForAdmin('GENRE');

    expect(rows[0]?.label).toBe('（未設定）');
  });
});

describe('戦略別', () => {
  it('実験グループごとにまとめる', async () => {
    const group = await prisma.experimentGroup.create({
      data: {
        name: 'Group A：標準運用',
        description: '標準',
        strategyType: 'STANDARD',
        settings: {},
        startDate: METRIC_DATE,
      },
      select: { id: true },
    });

    const { blogId } = await setup();
    await prisma.blog.update({
      where: { id: blogId },
      data: { experimentGroupId: group.id },
    });

    await prisma.metricDaily.create({
      data: { blogId, metricDate: METRIC_DATE, conversions: 4 },
    });

    const rows = await aggregateForAdmin('STRATEGY');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: 'Group A：標準運用',
      blogs: 1,
      conversions: 4,
    });
  });

  it('グループ未割当は（未設定）として並ぶ', async () => {
    await setup();

    expect((await aggregateForAdmin('STRATEGY'))[0]?.label).toBe('（未設定）');
  });
});

/**
 * **測っていない列を出さない**（Q-032）。0として並べると
 * 「測ったが0だった」と読める
 */
describe('測っていないもの', () => {
  it('広告クリックとPVを返さない', async () => {
    await setup();

    const row = (await aggregateForAdmin('BLOG'))[0];

    expect(row).not.toHaveProperty('bannerClicks');
    expect(row).not.toHaveProperty('pageViews');
  });
});
