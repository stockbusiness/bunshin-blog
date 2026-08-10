import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * `approvals` の制約を**実PostgreSQLで**確かめる（TASKS F-1-schema）。
 *
 * 確かめるのは1点だけ — **同じ記事の版を二度提案できない。**
 *
 * 提案はLINE通知を伴うため、二重に作ると同じ記事の確認依頼が2通届く。
 * SPEC 8.3 は「同一提案を連続通知しない」と定めているが、**通知の側で
 * 数えるより、作れないようにするほうが確実**（C-6 と同じ筋）。
 *
 * 提案を作る実装は F-1。ここでは Prisma で直接入れて確かめる。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let contentItemId: string;
let articleVersionId: string;

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
  userId = user.id;
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;

  const plan = await prisma.contentPlan.create({
    data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: 1,
      contentType: 'INFORMATIONAL',
      title: '記事',
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: 1,
    },
    select: { id: true },
  });
  contentItemId = item.id;

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId,
      versionNo: 1,
      title: 'タイトル',
      excerpt: '要約',
      answerCapsule: '結論',
      bodyHtml: '<p>本文</p>',
      faqJson: [],
      structuredDataJson: [],
      factCheckStatus: 'PASSED',
      riskFlags: [],
      usedFactIds: [],
      unverifiedClaims: [],
      modelProvider: 'anthropic',
      modelName: 'test',
      promptVersion: 'v1',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      contentHash: 'x'.repeat(64),
    },
    select: { id: true },
  });
  articleVersionId = version.id;
});

function approval(status: 'PENDING' | 'SKIPPED') {
  return {
    userId,
    blogId,
    contentItemId,
    articleVersionId,
    status,
    proposalType: 'NEW_ARTICLE' as const,
    priorityScore: 10,
    proposalReason: '理由',
  };
}

describe('同じ記事の版を二度提案できない', () => {
  it('1件目は入る', async () => {
    await expect(
      prisma.approval.create({ data: approval('PENDING') }),
    ).resolves.toMatchObject({ articleVersionId });
  });

  it('2件目は落ちる', async () => {
    await prisma.approval.create({ data: approval('PENDING') });

    // 一意違反は SQLSTATE 23505
    await expect(
      prisma.approval.create({ data: approval('PENDING') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  /**
   * **見送られた版も作り直さない。** 状態を問わない一意にしている理由。
   * 修正依頼を受けたときは E-10 が `version_no` を増やした新しい版を作るので、
   * 再提案は常に別の版になる
   */
  it('見送りのあとでも同じ版は提案できない', async () => {
    await prisma.approval.create({ data: approval('SKIPPED') });

    await expect(
      prisma.approval.create({ data: approval('PENDING') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('別の版なら提案できる', async () => {
    await prisma.approval.create({ data: approval('PENDING') });

    const second = await prisma.articleVersion.create({
      data: {
        contentItemId,
        versionNo: 2,
        title: 'タイトル2',
        excerpt: '要約',
        answerCapsule: '結論',
        bodyHtml: '<p>本文2</p>',
        faqJson: [],
        structuredDataJson: [],
        factCheckStatus: 'PASSED',
        riskFlags: [],
        usedFactIds: [],
        unverifiedClaims: [],
        modelProvider: 'anthropic',
        modelName: 'test',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
        contentHash: 'y'.repeat(64),
      },
      select: { id: true },
    });

    await expect(
      prisma.approval.create({
        data: { ...approval('PENDING'), articleVersionId: second.id },
      }),
    ).resolves.toMatchObject({ articleVersionId: second.id });
  });
});
