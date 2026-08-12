import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { countApprovalActivityForAdmin } from '@/modules/approvals';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * モニターの反応を数える（TASKS J-5）。
 *
 * **Phase 0 で最も起きやすい失敗は「モニターが承認しない」。**
 * ここで確かめるのは、**数え方が「打つ手」と噛み合っていること。**
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

const NOW = new Date('2026-08-12T03:00:00.000Z');

async function createApproval(params: {
  status:
    | 'PENDING'
    | 'VIEWED'
    | 'APPROVED'
    | 'REVISION_REQUESTED'
    | 'SKIPPED'
    | 'EXPIRED';
  sentAt: Date | null;
  ownerId?: string;
}): Promise<void> {
  const owner = params.ownerId ?? userId;
  const targetBlogId =
    params.ownerId === undefined
      ? blogId
      : (await createBlog(prisma, owner, { name: '他人' })).id;

  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: {
        blogId: targetBlogId,
        planType: 'INITIAL',
        version: 1,
      },
    },
    update: {},
    create: {
      blogId: targetBlogId,
      planType: 'INITIAL',
      version: 1,
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const sequenceNo =
    (await prisma.contentItem.count({ where: { contentPlanId: plan.id } })) + 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: targetBlogId,
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
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
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
      contentHash: `${item.id}`.padEnd(64, 'x').slice(0, 64),
    },
    select: { id: true },
  });

  await prisma.approval.create({
    data: {
      userId: owner,
      blogId: targetBlogId,
      contentItemId: item.id,
      articleVersionId: version.id,
      status: params.status,
      proposalType: 'NEW_ARTICLE',
      priorityScore: 100,
      proposalReason: '集客記事です。読者を収益記事へ誘導します。',
      ...(params.sentAt === null ? {} : { sentAt: params.sentAt }),
    },
  });
}

function countFor(userIdToRead: string) {
  return countApprovalActivityForAdmin({ now: NOW }).then(
    (counts) => counts.get(userIdToRead) ?? { sent: 0, responded: 0 },
  );
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

  const user = await createUser(prisma);
  userId = user.id;
  blogId = (await createBlog(prisma, user.id, { name: 'ブログ' })).id;
});

/**
 * **作ったが送れていないものを分母に入れると、通知が止まっている
 * だけの人が「反応が悪い」に見える**
 */
describe('送れた提案だけを数える', () => {
  it('送っていない提案は数えない', async () => {
    await createApproval({ status: 'PENDING', sentAt: null });

    expect(await countFor(userId)).toEqual({ sent: 0, responded: 0 });
  });

  it('期間より前に送ったものは数えない', async () => {
    await createApproval({
      status: 'APPROVED',
      sentAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(await countFor(userId)).toEqual({ sent: 0, responded: 0 });
  });
});

describe('反応に数えるもの', () => {
  it.each([
    { name: '承認', status: 'APPROVED' as const },
    { name: '見送り', status: 'SKIPPED' as const },
    { name: '修正依頼', status: 'REVISION_REQUESTED' as const },
  ])('$name は反応に数える', async ({ status }) => {
    await createApproval({ status, sentAt: NOW });

    expect(await countFor(userId)).toEqual({ sent: 1, responded: 1 });
  });

  /** **開いて閉じたのは判断ではない** */
  it('見ただけは反応に数えない', async () => {
    await createApproval({ status: 'VIEWED', sentAt: NOW });

    expect(await countFor(userId)).toEqual({ sent: 1, responded: 0 });
  });

  it('まだ押していないものは反応に数えない', async () => {
    await createApproval({ status: 'PENDING', sentAt: NOW });

    expect(await countFor(userId)).toEqual({ sent: 1, responded: 0 });
  });

  /** **押されないまま期限が来たもの**（F-3b） */
  it('期限切れは反応に数えない', async () => {
    await createApproval({ status: 'EXPIRED', sentAt: NOW });

    expect(await countFor(userId)).toEqual({ sent: 1, responded: 0 });
  });
});

describe('利用者ごとに分かれる', () => {
  it('他人の提案が混ざらない', async () => {
    const other = await createUser(prisma);

    await createApproval({ status: 'APPROVED', sentAt: NOW });
    await createApproval({
      status: 'PENDING',
      sentAt: NOW,
      ownerId: other.id,
    });

    expect(await countFor(userId)).toEqual({ sent: 1, responded: 1 });
    expect(await countFor(other.id)).toEqual({ sent: 1, responded: 0 });
  });

  /** 提案が1件も無い利用者は表に現れない（呼び出し側が0として扱う） */
  it('提案が無ければ入っていない', async () => {
    const counts = await countApprovalActivityForAdmin({ now: NOW });

    expect(counts.has(userId)).toBe(false);
  });
});
