import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  APPROVAL_ERROR_CODES,
  approveForUser,
  listRevisionRequestsForUser,
  markViewedForUser,
  readApprovalDetailForUser,
  requestRevisionForUser,
  skipForUser,
} from '@/modules/approvals';
import { listAuditLogsForAdmin } from '@/modules/audit';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 承認・修正依頼・見送りを**実PostgreSQLで**確かめる（TASKS F-6）。
 *
 * 完了条件は「**トランザクションと冪等性を持つ**」（SPEC 13.6）。
 *
 * - 冪等：同じ答えを二度送っても成功する
 * - 違う答えは受け付けない（409）
 * - 承認の記録と記事の状態が**同時に**決まる
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let approvalId: string;
let contentItemId: string;

const NOW = new Date('2026-08-10T00:00:00.000Z');

async function createApproval(): Promise<{
  approvalId: string;
  contentItemId: string;
}> {
  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: { blogId, planType: 'INITIAL', version: 1 },
    },
    update: {},
    create: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const sequenceNo =
    (await prisma.contentItem.count({ where: { contentPlanId: plan.id } })) + 1;

  const item = await prisma.contentItem.create({
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
      // 提案が作られた直後の状態（F-1）
      status: 'READY_FOR_REVIEW',
    },
    select: { id: true },
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
      versionNo: 1,
      title: `タイトル${sequenceNo}`,
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

  const approval = await prisma.approval.create({
    data: {
      userId,
      blogId,
      contentItemId: item.id,
      articleVersionId: version.id,
      status: 'PENDING',
      proposalType: 'NEW_ARTICLE',
      priorityScore: 100,
      proposalReason: '理由',
      sentAt: NOW,
    },
    select: { id: true },
  });

  return { approvalId: approval.id, contentItemId: item.id };
}

async function itemStatus(id: string): Promise<string | undefined> {
  const item = await prisma.contentItem.findUnique({
    where: { id },
    select: { status: true },
  });

  return item?.status;
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
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;

  const created = await createApproval();
  approvalId = created.approvalId;
  contentItemId = created.contentItemId;
});

describe('承認', () => {
  it('承認すると記事も承認済みになる', async () => {
    const approval = await approveForUser({ userId, approvalId, now: NOW });

    expect(approval.status).toBe('APPROVED');
    expect(await itemStatus(contentItemId)).toBe('APPROVED');
  });

  it('responded_at が入る', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { respondedAt: true },
    });

    expect(row?.respondedAt?.getTime()).toBe(NOW.getTime());
  });

  /** **二度押しでエラーを返すと三度押される** */
  it('二度送っても成功する（冪等）', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    const second = await approveForUser({ userId, approvalId, now: NOW });

    expect(second.status).toBe('APPROVED');
  });

  it('二度目に responded_at を書き換えない', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    const later = new Date('2026-08-11T00:00:00.000Z');
    await approveForUser({ userId, approvalId, now: later });

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { respondedAt: true },
    });

    expect(row?.respondedAt?.getTime()).toBe(NOW.getTime());
  });
});

describe('見送り', () => {
  it('見送ると記事が却下になる', async () => {
    const approval = await skipForUser({ userId, approvalId, now: NOW });

    expect(approval.status).toBe('SKIPPED');
    expect(await itemStatus(contentItemId)).toBe('REJECTED');
  });

  it('二度送っても成功する（冪等）', async () => {
    await skipForUser({ userId, approvalId, now: NOW });

    await expect(
      skipForUser({ userId, approvalId, now: NOW }),
    ).resolves.toMatchObject({ status: 'SKIPPED' });
  });
});

describe('修正依頼', () => {
  /** **作り直すため `PLANNED` へ戻す**（`article_versions` は上書きしない） */
  it('依頼すると記事が計画済みへ戻る', async () => {
    const approval = await requestRevisionForUser({
      userId,
      approvalId,
      requestType: 'SHORTER',
      now: NOW,
    });

    expect(approval.status).toBe('REVISION_REQUESTED');
    expect(await itemStatus(contentItemId)).toBe('PLANNED');
  });

  it('依頼の内容が残る', async () => {
    await requestRevisionForUser({
      userId,
      approvalId,
      requestType: 'FACT_ERROR',
      comment: '料金が違います',
      now: NOW,
    });

    const requests = await listRevisionRequestsForUser({ userId, approvalId });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestType).toBe('FACT_ERROR');
    expect(requests[0]?.comment).toBe('料金が違います');
  });

  /** **何を直すか分からない依頼を残さない** */
  it('自由記述で本文が無ければ落とす', async () => {
    await expect(
      requestRevisionForUser({
        userId,
        approvalId,
        requestType: 'FREE_TEXT',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.invalidRevision });

    expect(await itemStatus(contentItemId)).toBe('READY_FOR_REVIEW');
  });

  it('空白だけの本文も落とす', async () => {
    await expect(
      requestRevisionForUser({
        userId,
        approvalId,
        requestType: 'FREE_TEXT',
        comment: '   ',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.invalidRevision });
  });

  it('長すぎる本文を落とす', async () => {
    await expect(
      requestRevisionForUser({
        userId,
        approvalId,
        requestType: 'FREE_TEXT',
        comment: 'あ'.repeat(1_001),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.invalidRevision });
  });

  /** **依頼は増える。** 二度目も記録として残す */
  it('二度送っても成功する（冪等）', async () => {
    await requestRevisionForUser({
      userId,
      approvalId,
      requestType: 'SHORTER',
      now: NOW,
    });

    await expect(
      requestRevisionForUser({
        userId,
        approvalId,
        requestType: 'SHORTER',
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'REVISION_REQUESTED' });
  });
});

describe('違う答えは受け付けない', () => {
  /** **承認した提案を見送りへ変えられると、何を承認したのか分からなくなる** */
  it('承認済みを見送りへ変えられない', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    await expect(
      skipForUser({ userId, approvalId, now: NOW }),
    ).rejects.toMatchObject({
      code: APPROVAL_ERROR_CODES.alreadyDecided,
      status: 409,
    });

    expect(await itemStatus(contentItemId)).toBe('APPROVED');
  });

  it('見送り済みを承認へ変えられない', async () => {
    await skipForUser({ userId, approvalId, now: NOW });

    await expect(
      approveForUser({ userId, approvalId, now: NOW }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.alreadyDecided });
  });

  it('修正依頼済みを承認へ変えられない', async () => {
    await requestRevisionForUser({
      userId,
      approvalId,
      requestType: 'SOFTER',
      now: NOW,
    });

    await expect(
      approveForUser({ userId, approvalId, now: NOW }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.alreadyDecided });
  });
});

describe('トランザクション（完了条件）', () => {
  /**
   * **承認の記録と記事の状態は同時に決まる。** 片方だけ残ると、
   * 承認済みなのに `PLANNED` の記事や、その逆が生まれる
   */
  it('修正依頼が落ちたら記事の状態も動かない', async () => {
    await expect(
      requestRevisionForUser({
        userId,
        approvalId,
        requestType: 'FREE_TEXT',
        comment: '',
        now: NOW,
      }),
    ).rejects.toThrow();

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { status: true, respondedAt: true },
    });

    expect(row?.status).toBe('PENDING');
    expect(row?.respondedAt).toBeNull();
    expect(await itemStatus(contentItemId)).toBe('READY_FOR_REVIEW');
    expect(await prisma.revisionRequest.count()).toBe(0);
  });

  /** **既に投稿された記事を巻き戻さない** */
  it('承認待ちでない記事の状態は動かさない', async () => {
    await prisma.contentItem.update({
      where: { id: contentItemId },
      data: { status: 'POSTED' },
    });

    await approveForUser({ userId, approvalId, now: NOW });

    expect(await itemStatus(contentItemId)).toBe('POSTED');
  });
});

describe('開いた記録（SPEC 13.6 の POST /view）', () => {
  /** **読み取りで状態が変わらない。** 一覧の先読みで「開いた」にしない */
  it('詳細を読むだけでは VIEWED にならない', async () => {
    await readApprovalDetailForUser({ userId, approvalId });

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { status: true, viewedAt: true },
    });

    expect(row?.status).toBe('PENDING');
    expect(row?.viewedAt).toBeNull();
  });

  it('view を送ると VIEWED になる', async () => {
    const approval = await markViewedForUser({ userId, approvalId, now: NOW });

    expect(approval.status).toBe('VIEWED');
  });

  /** **`viewed_at` は最初に開いた時刻のまま** */
  it('二度目に viewed_at を書き換えない', async () => {
    await markViewedForUser({ userId, approvalId, now: NOW });
    await markViewedForUser({
      userId,
      approvalId,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { viewedAt: true },
    });

    expect(row?.viewedAt?.getTime()).toBe(NOW.getTime());
  });

  it('答えた提案を VIEWED へ戻さない', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const approval = await markViewedForUser({ userId, approvalId, now: NOW });

    expect(approval.status).toBe('APPROVED');
  });

  it('VIEWED からでも承認できる', async () => {
    await markViewedForUser({ userId, approvalId, now: NOW });

    await expect(
      approveForUser({ userId, approvalId, now: NOW }),
    ).resolves.toMatchObject({ status: 'APPROVED' });
  });
});

describe('他人の承認は決められない', () => {
  it.each([
    ['承認', approveForUser],
    ['見送り', skipForUser],
    ['開いた記録', markViewedForUser],
  ])('%s は 404', async (_name, action) => {
    const other = await createUser(prisma);

    await expect(
      action({ userId: other.id, approvalId, now: NOW }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.notFound });
  });

  /** **他人が叩いても、相手の記録は1バイトも変わらない** */
  it('他人が叩いても状態が変わらない', async () => {
    const other = await createUser(prisma);

    await expect(
      approveForUser({ userId: other.id, approvalId, now: NOW }),
    ).rejects.toThrow();

    const row = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { status: true, respondedAt: true },
    });

    expect(row?.status).toBe('PENDING');
    expect(row?.respondedAt).toBeNull();
    expect(await itemStatus(contentItemId)).toBe('READY_FOR_REVIEW');
  });

  it('修正依頼も他人からは 404', async () => {
    const other = await createUser(prisma);

    await expect(
      requestRevisionForUser({
        userId: other.id,
        approvalId,
        requestType: 'SHORTER',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: APPROVAL_ERROR_CODES.notFound });
  });
});

/**
 * 監査ログ（TASKS H-12、SPEC 14.4「承認」、Q-027）。
 *
 * **誰がいつ何を通したかが分からないと、実験の結果を検証できない。**
 */
describe('承認の記録', () => {
  it('承認すると残る', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const logs = await listAuditLogsForAdmin({ entityType: 'approval' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: userId,
      action: 'ARTICLE_APPROVED',
      entityId: approvalId,
    });
    expect(logs[0]?.metadata).toMatchObject({ blogId, contentItemId });
  });

  /** **本文もタイトルも入れない。** 追えれば足りる（SPEC 14.2） */
  it('記事の中身を入れない', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const [log] = await listAuditLogsForAdmin({ entityType: 'approval' });

    expect(JSON.stringify(log?.metadata)).not.toContain('タイトル');
  });

  /** 二度押しで2行にならない（冪等） */
  it('二度承認しても1件', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    await approveForUser({ userId, approvalId, now: NOW });

    expect(
      await listAuditLogsForAdmin({ entityType: 'approval' }),
    ).toHaveLength(1);
  });

  /**
   * **全ての決定を残さない。** SPEC 14.4 の一覧は「承認」だけで、
   * 正常系を全部残すと異常が埋もれる
   */
  it.each([
    {
      name: '見送り',
      act: () => skipForUser({ userId, approvalId, now: NOW }),
    },
    {
      name: '修正依頼',
      act: () =>
        requestRevisionForUser({
          userId,
          approvalId,
          requestType: 'SHORTER',
          now: NOW,
        }),
    },
  ])('$name は残さない', async ({ act }) => {
    await act();

    expect(await listAuditLogsForAdmin({ entityType: 'approval' })).toEqual([]);
  });
});
