import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * `metrics_daily` の一意制約を**実PostgreSQLで**確かめる（TASKS G-5-schema）。
 *
 * 確かめるのは1点だけ — **記事に紐づかない行が重複しない。**
 *
 * PostgreSQL は既定で NULL 同士を「違う値」として扱う。
 * `content_item_id IS NULL` の行は、同じブログの同じ日でも何行でも入る。
 * **重複した行は集計（G-6）で二重に数えられ、しかも気づけない。**
 */

let prisma: PrismaClient;
let blogId: string;

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const user = await createUser(prisma);
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;
});

function row(overrides: { metricDate?: Date; conversions?: number } = {}) {
  return {
    blogId,
    metricDate: overrides.metricDate ?? new Date('2026-08-10T00:00:00.000Z'),
    conversions: overrides.conversions ?? 0,
  };
}

describe('記事に紐づかない行は重複しない', () => {
  it('1件目は入る', async () => {
    await expect(
      prisma.metricDaily.create({ data: row() }),
    ).resolves.toMatchObject({ blogId });
  });

  /** **NULL 同士も同じ値として扱う**（`NULLS NOT DISTINCT`） */
  it('同じブログの同じ日は2件目が落ちる', async () => {
    await prisma.metricDaily.create({ data: row() });

    await expect(
      prisma.metricDaily.create({ data: row({ conversions: 5 }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('日が違えば入る', async () => {
    await prisma.metricDaily.create({ data: row() });

    await expect(
      prisma.metricDaily.create({
        data: row({ metricDate: new Date('2026-08-17T00:00:00.000Z') }),
      }),
    ).resolves.toMatchObject({ blogId });
  });

  it('ブログが違えば入る', async () => {
    await prisma.metricDaily.create({ data: row() });

    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      prisma.metricDaily.create({
        data: { ...row(), blogId: otherBlog.id },
      }),
    ).resolves.toMatchObject({ blogId: otherBlog.id });
  });

  /** 記事ごとの行（G-2 が入れる）は今までどおり */
  it('記事に紐づく行は記事ごとに入る', async () => {
    const plan = await prisma.contentPlan.create({
      data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
      select: { id: true },
    });

    const items = [];
    for (const sequenceNo of [1, 2]) {
      items.push(
        await prisma.contentItem.create({
          data: {
            contentPlanId: plan.id,
            blogId,
            sequenceNo,
            contentType: 'INFORMATIONAL',
            title: `記事${sequenceNo}`,
            searchIntent: '意図',
            objective: 'TRAFFIC',
            inboundLinkItemIds: [],
            outboundLinkItemIds: [],
            publishPriority: sequenceNo,
          },
          select: { id: true },
        }),
      );
    }

    for (const item of items) {
      await prisma.metricDaily.create({
        data: { ...row(), contentItemId: item.id },
      });
    }

    expect(await prisma.metricDaily.count()).toBe(2);
  });
});
