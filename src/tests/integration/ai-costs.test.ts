import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  AI_COST_ERROR_CODES,
  listAiUsageForUser,
  recordAiUsage,
  summarizeByUserForAdmin,
  summarizeCostForUser,
  totalBlogCostForUser,
  totalContentItemCostForUser,
  totalCostForUser,
  type RecordAiUsageInput,
} from '@/modules/ai-costs';
import { createBlogForUser } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * AI費用ログを**実PostgreSQLで**確かめる（TASKS E-14、SPEC 12.1）。
 *
 * 完了条件は「**ユーザー別・ブログ別・記事別・モデル別に記録される**」。
 *
 * `cost_usd` は `decimal(10,6)`。**小数の丸めは実DBでしか確かめられない** —
 * 1回あたり0.001ドルを下回ることがあり、丸めると積み上げが合わなくなる。
 */

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;
let contentItemId: string;

async function createContentItem(blogId: string): Promise<string> {
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

  return item.id;
}

function usage(
  overrides: Partial<RecordAiUsageInput> = {},
): RecordAiUsageInput {
  return {
    userId: owner.id,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    operation: 'ARTICLE_BODY',
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    ...overrides,
  };
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

  owner = await createUser(prisma, { displayName: '所有者' });
  other = await createUser(prisma, { displayName: '別ユーザー' });

  blog1 = (
    await createBlogForUser(owner.id, {
      name: 'ブログ1',
      slug: 'mine-1',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  blog2 = (
    await createBlogForUser(owner.id, {
      name: 'ブログ2',
      slug: 'mine-2',
      targetReader: '読者',
      slotNumber: 2,
    })
  ).id;
  otherBlog = (
    await createBlogForUser(other.id, {
      name: '他人のブログ',
      slug: 'theirs',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  contentItemId = await createContentItem(blog1);
});

describe('記録', () => {
  it('1回の呼び出しを記録する', async () => {
    const log = await recordAiUsage(
      usage({ blogId: blog1, contentItemId, webSearchCalls: 2 }),
    );

    expect(log).toMatchObject({
      userId: owner.id,
      blogId: blog1,
      contentItemId,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      operation: 'ARTICLE_BODY',
      inputTokens: 1000,
      outputTokens: 500,
      webSearchCalls: 2,
      costUsd: 0.01,
    });
  });

  /** 1回あたり0.001ドルを下回ることがある。丸めると積み上げが合わない */
  it('小数6桁まで保つ', async () => {
    const log = await recordAiUsage(usage({ costUsd: 0.000123 }));

    expect(log.costUsd).toBe(0.000123);

    const row = await prisma.aiUsageLog.findUniqueOrThrow({
      where: { id: log.id },
      select: { costUsd: true },
    });
    expect(row.costUsd.toNumber()).toBe(0.000123);
  });

  /**
   * **記録そのものを飛ばさない。** 後から単価を入れても、
   * 何回呼んだかすら分からなくなる。
   */
  it('単価が無くても記録は残る', async () => {
    const log = await recordAiUsage(usage({ costUsd: null }));

    expect(log.costUsd).toBe(0);
    expect(log.inputTokens).toBe(1000);
  });

  it('ブログや記事に紐づかない呼び出しも記録できる', async () => {
    const log = await recordAiUsage(
      usage({
        operation: 'MONTHLY_STRATEGY',
        blogId: null,
        contentItemId: null,
      }),
    );

    expect(log.blogId).toBeNull();
    expect(log.contentItemId).toBeNull();
  });

  it.each([[-1], [1.5]])('トークン数 %s を拒否する', async (inputTokens) => {
    await expect(recordAiUsage(usage({ inputTokens }))).rejects.toMatchObject({
      code: AI_COST_ERROR_CODES.invalidUsage,
    });
  });

  it('負の費用を拒否する', async () => {
    await expect(recordAiUsage(usage({ costUsd: -1 }))).rejects.toMatchObject({
      code: AI_COST_ERROR_CODES.invalidUsage,
    });
  });
});

describe('集計の切り口（完了条件）', () => {
  beforeEach(async () => {
    await recordAiUsage(usage({ blogId: blog1, contentItemId, costUsd: 0.05 }));
    await recordAiUsage(
      usage({
        blogId: blog1,
        contentItemId,
        model: 'claude-haiku-4-5-20251001',
        operation: 'CLASSIFY',
        costUsd: 0.001,
      }),
    );
    await recordAiUsage(usage({ blogId: blog2, costUsd: 0.02 }));
  });

  it('ブログ別に集計できる', async () => {
    const summary = await summarizeCostForUser(owner.id, { groupBy: 'blog' });

    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({ key: blog1, calls: 2 });
    expect(summary[0]?.costUsd).toBeCloseTo(0.051);
    expect(summary[1]).toMatchObject({ key: blog2, calls: 1 });
  });

  it('記事別に集計できる', async () => {
    const summary = await summarizeCostForUser(owner.id, {
      groupBy: 'contentItem',
    });

    const forItem = summary.find((entry) => entry.key === contentItemId);
    expect(forItem?.calls).toBe(2);
    expect(forItem?.costUsd).toBeCloseTo(0.051);
  });

  it('モデル別に集計できる', async () => {
    const summary = await summarizeCostForUser(owner.id, { groupBy: 'model' });

    expect(summary.map((entry) => entry.key).sort()).toEqual(
      ['claude-haiku-4-5-20251001', 'claude-sonnet-5'].sort(),
    );
  });

  it('用途別に集計できる', async () => {
    const summary = await summarizeCostForUser(owner.id, {
      groupBy: 'operation',
    });

    expect(summary.find((entry) => entry.key === 'CLASSIFY')?.calls).toBe(1);
  });

  /** ADMIN 用。SPEC 12.1「ユーザー別」 */
  it('ユーザー別に集計できる（ADMIN）', async () => {
    await recordAiUsage(usage({ userId: other.id, costUsd: 0.3 }));

    const summary = await summarizeByUserForAdmin();

    expect(summary).toHaveLength(2);
    expect(summary[0]?.key).toBe(other.id);
  });

  /**
   * **0円の合計を見て「安く済んでいる」と誤解しない。**
   * 費用を計算できなかった呼び出しの数を返す。
   */
  it('単価未設定の件数を数える', async () => {
    await recordAiUsage(usage({ blogId: blog1, costUsd: null }));

    const summary = await summarizeCostForUser(owner.id, { groupBy: 'blog' });

    expect(summary.find((entry) => entry.key === blog1)?.unpricedCalls).toBe(1);
  });
});

describe('合計と所有権（SPEC 14.1）', () => {
  beforeEach(async () => {
    await recordAiUsage(usage({ blogId: blog1, contentItemId, costUsd: 0.05 }));
    await recordAiUsage(
      usage({ userId: other.id, blogId: otherBlog, costUsd: 9 }),
    );
  });

  it('自分の合計だけを返す', async () => {
    expect(await totalCostForUser(owner.id)).toBeCloseTo(0.05);
    expect(await totalCostForUser(other.id)).toBeCloseTo(9);
  });

  it('ブログの合計を返す', async () => {
    expect(
      await totalBlogCostForUser({ userId: owner.id, blogId: blog1 }),
    ).toBeCloseTo(0.05);
  });

  it('他人のブログの費用は見えない', async () => {
    await expect(
      totalBlogCostForUser({ userId: owner.id, blogId: otherBlog }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('記事の費用を返す', async () => {
    expect(
      await totalContentItemCostForUser({
        userId: owner.id,
        blogId: blog1,
        contentItemId,
      }),
    ).toBeCloseTo(0.05);
  });

  /** `content_item_id` だけで引くと他人の記事の費用が見える */
  it('他人のブログ経由では記事の費用を見られない', async () => {
    await expect(
      totalContentItemCostForUser({
        userId: owner.id,
        blogId: otherBlog,
        contentItemId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('一覧に他人の記録は出ない', async () => {
    const logs = await listAiUsageForUser(owner.id);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.userId).toBe(owner.id);
  });
});

describe('期間の絞り込み', () => {
  it('期間の外は数えない', async () => {
    const log = await recordAiUsage(usage({ costUsd: 0.05 }));

    await prisma.aiUsageLog.update({
      where: { id: log.id },
      data: { createdAt: new Date('2026-07-01T00:00:00Z') },
    });

    const inJuly = await totalCostForUser(owner.id, {
      from: new Date('2026-07-01T00:00:00Z'),
      to: new Date('2026-08-01T00:00:00Z'),
    });
    const inAugust = await totalCostForUser(owner.id, {
      from: new Date('2026-08-01T00:00:00Z'),
      to: new Date('2026-09-01T00:00:00Z'),
    });

    expect(inJuly).toBeCloseTo(0.05);
    expect(inAugust).toBe(0);
  });

  /** `to` を含めると、月末の呼び出しが2つの月に数えられる */
  it('終端は含まない', async () => {
    const log = await recordAiUsage(usage({ costUsd: 0.05 }));

    await prisma.aiUsageLog.update({
      where: { id: log.id },
      data: { createdAt: new Date('2026-08-01T00:00:00Z') },
    });

    expect(
      await totalCostForUser(owner.id, {
        from: new Date('2026-07-01T00:00:00Z'),
        to: new Date('2026-08-01T00:00:00Z'),
      }),
    ).toBe(0);
  });
});
