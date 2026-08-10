import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  approvalTabOf,
  listApprovalSummariesForUser,
  listApprovalsForUser,
  refreshProposalsForUser,
} from '@/modules/approvals';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 提案の作成を**実PostgreSQLで**確かめる（TASKS F-1）。
 *
 * 完了条件は「**優先度と提案理由が保存される**」。
 *
 * あわせて SPEC 9.1 の「3ブログ横断で優先順位を付ける」と、
 * E-12・E-13 を通っていない記事が提案されないことを確かめる。
 */

let prisma: PrismaClient;
let userId: string;

const NOW = new Date('2026-08-10T00:00:00.000Z');

interface ArticleOptions {
  blogId: string;
  publishPriority: number;
  factCheckStatus?: 'PASSED' | 'WARNING' | 'FAILED' | 'NOT_CHECKED';
  riskFlags?: { code: string; severity: string; message: string }[];
  contentType?: 'INFORMATIONAL' | 'AFFILIATE';
  status?: 'PLANNED' | 'APPROVED';
  outboundLinkItemIds?: string[];
}

/** 記事1本とその最新版を用意する */
async function createArticle(
  options: ArticleOptions,
): Promise<{ contentItemId: string; articleVersionId: string }> {
  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: {
        blogId: options.blogId,
        planType: 'INITIAL',
        version: 1,
      },
    },
    update: {},
    create: {
      blogId: options.blogId,
      planType: 'INITIAL',
      version: 1,
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const sequenceNo = await prisma.contentItem.count({
    where: { contentPlanId: plan.id },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: options.blogId,
      sequenceNo: sequenceNo + 1,
      contentType: options.contentType ?? 'INFORMATIONAL',
      title: `記事${options.publishPriority}`,
      searchIntent: '意図',
      objective: options.contentType === 'AFFILIATE' ? 'REVENUE' : 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: options.outboundLinkItemIds ?? [],
      publishPriority: options.publishPriority,
      status: options.status ?? 'PLANNED',
    },
    select: { id: true },
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
      versionNo: 1,
      title: `タイトル${options.publishPriority}`,
      excerpt: '要約',
      answerCapsule: '結論',
      bodyHtml: '<p>本文</p>',
      faqJson: [],
      structuredDataJson: [],
      factCheckStatus: options.factCheckStatus ?? 'PASSED',
      riskFlags: options.riskFlags ?? [],
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

  return { contentItemId: item.id, articleVersionId: version.id };
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
});

describe('優先度と提案理由が保存される（完了条件）', () => {
  it('提案が作られる', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });

    const result = await refreshProposalsForUser(userId, { now: NOW });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.priorityScore).toBeGreaterThan(0);
    expect(result.created[0]?.proposalReason.length).toBeGreaterThan(0);
    expect(result.created[0]?.status).toBe('PENDING');
    expect(result.created[0]?.proposalType).toBe('NEW_ARTICLE');
  });

  it('記事が「承認待ち」になる', async () => {
    const blog = await createBlog(prisma, userId);
    const article = await createArticle({
      blogId: blog.id,
      publishPriority: 1,
    });

    await refreshProposalsForUser(userId, { now: NOW });

    const item = await prisma.contentItem.findUnique({
      where: { id: article.contentItemId },
      select: { status: true },
    });

    expect(item?.status).toBe('READY_FOR_REVIEW');
  });

  it('候補が無ければ何も作らない', async () => {
    await createBlog(prisma, userId);

    const result = await refreshProposalsForUser(userId, { now: NOW });

    expect(result.created).toEqual([]);
    expect(await prisma.approval.count()).toBe(0);
  });
});

describe('検査を通っていない記事は提案しない', () => {
  /** **E-12 の判定。** `FAILED` は承認依頼へ送らない（SPEC 9.7） */
  it('FAILED の記事は提案しない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      factCheckStatus: 'FAILED',
    });

    const result = await refreshProposalsForUser(userId, { now: NOW });

    expect(result.created).toEqual([]);
  });

  it('NOT_CHECKED の記事は提案しない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      factCheckStatus: 'NOT_CHECKED',
    });

    expect(
      (await refreshProposalsForUser(userId, { now: NOW })).created,
    ).toEqual([]);
  });

  /** **E-13 の判定。** `error` のフラグがあれば送らない */
  it('error のリスクフラグがあれば提案しない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      riskFlags: [{ code: 'NG_EXPRESSION', severity: 'error', message: 'x' }],
    });

    expect(
      (await refreshProposalsForUser(userId, { now: NOW })).created,
    ).toEqual([]);
  });

  it('warning のリスクフラグなら提案する', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      riskFlags: [
        { code: 'ASSERTIVE_CLAIM', severity: 'warning', message: 'x' },
      ],
    });

    const result = await refreshProposalsForUser(userId, { now: NOW });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.proposalReason).toContain('1件の指摘');
  });

  it('既に承認済みの記事は提案しない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      status: 'APPROVED',
    });

    expect(
      (await refreshProposalsForUser(userId, { now: NOW })).created,
    ).toEqual([]);
  });
});

describe('二度提案しない', () => {
  /** F-1-schema の一意制約が最後の砦。ここでは握り潰さず数える */
  it('同じ版は2回目に作らない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });

    await refreshProposalsForUser(userId, { now: NOW });

    // 1回目で `READY_FOR_REVIEW` になるため、そのままでは候補に残らない。
    // **状態を戻しても二重提案にならないこと**を確かめる
    await prisma.contentItem.updateMany({
      where: { blogId: blog.id },
      data: { status: 'PLANNED' },
    });

    const second = await refreshProposalsForUser(userId, { now: NOW });

    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(await prisma.approval.count()).toBe(1);
  });
});

describe('3ブログ横断で順位を付ける（SPEC 9.1）', () => {
  it('公開順の早い記事が上に来る', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 5 });
    await createArticle({ blogId: blog.id, publishPriority: 1 });

    await refreshProposalsForUser(userId, { now: NOW });

    const approvals = await listApprovalsForUser(userId);

    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.priorityScore).toBeGreaterThan(
      approvals[1]?.priorityScore ?? 0,
    );
  });

  /**
   * **1日1件しか送れないため**（SPEC 8.3）、提案の出ていないブログを
   * 上げないと、1つのブログだけが進み続ける
   */
  it('提案済みのブログより、まだ提案していないブログが上', async () => {
    const active = await createBlog(prisma, userId, { slotNumber: 1 });
    const quiet = await createBlog(prisma, userId, { slotNumber: 2 });

    await createArticle({ blogId: active.id, publishPriority: 1 });
    await refreshProposalsForUser(userId, { now: NOW });

    await createArticle({ blogId: active.id, publishPriority: 1 });
    await createArticle({ blogId: quiet.id, publishPriority: 1 });

    await refreshProposalsForUser(userId, { now: NOW });

    const open = await listApprovalsForUser(userId, { openOnly: true });
    const top = open[0];

    expect(top?.blogId).toBe(quiet.id);
    expect(top?.proposalReason).toContain('初めての提案');
  });
});

describe('他人の記事は提案されない', () => {
  it('他人のブログの記事は候補にならない', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);
    await createArticle({ blogId: otherBlog.id, publishPriority: 1 });

    const result = await refreshProposalsForUser(userId, { now: NOW });

    expect(result.created).toEqual([]);
    expect(await prisma.approval.count()).toBe(0);
  });

  it('一覧は自分の提案だけを返す', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });
    await refreshProposalsForUser(userId, { now: NOW });

    const other = await createUser(prisma);

    expect(await listApprovalsForUser(other.id)).toEqual([]);
  });

  /** `CLOSED` のブログは提案しない */
  it('CLOSED のブログは候補にならない', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });

    await prisma.blog.update({
      where: { id: blog.id },
      data: { status: 'CLOSED' },
    });

    expect(
      (await refreshProposalsForUser(userId, { now: NOW })).created,
    ).toEqual([]);
  });
});

describe('承認一覧（F-4、SPEC 6.1）', () => {
  /** 完了条件は「**他ユーザーの承認を開けない**」 */
  it('自分の提案だけが返る', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });
    await refreshProposalsForUser(userId, { now: NOW });

    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);
    await createArticle({ blogId: otherBlog.id, publishPriority: 1 });
    await refreshProposalsForUser(other.id, { now: NOW });

    const mine = await listApprovalSummariesForUser(userId);
    const theirs = await listApprovalSummariesForUser(other.id);

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);
    expect(mine[0]?.blogId).toBe(blog.id);
  });

  it('ブログ名と記事タイトルが載る', async () => {
    const blog = await createBlog(prisma, userId, { name: '節約ブログ' });
    await createArticle({ blogId: blog.id, publishPriority: 1 });
    await refreshProposalsForUser(userId, { now: NOW });

    const [summary] = await listApprovalSummariesForUser(userId);

    expect(summary?.blogName).toBe('節約ブログ');
    expect(summary?.articleTitle).toBe('タイトル1');
  });

  /** **確認が要ることを開く前に示す**（E-12・E-13） */
  it('事実チェックの結果と表現の指摘の件数が載る', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({
      blogId: blog.id,
      publishPriority: 1,
      factCheckStatus: 'WARNING',
      riskFlags: [
        { code: 'ASSERTIVE_CLAIM', severity: 'warning', message: 'x' },
        { code: 'EXAGGERATION', severity: 'warning', message: 'y' },
      ],
    });
    await refreshProposalsForUser(userId, { now: NOW });

    const [summary] = await listApprovalSummariesForUser(userId);

    expect(summary?.factCheckStatus).toBe('WARNING');
    expect(summary?.riskFlagCount).toBe(2);
  });

  /** **返事の済んだものは後ろ。** 待っているものから見せる */
  it('返事待ちが先に並ぶ', async () => {
    const blog = await createBlog(prisma, userId);
    await createArticle({ blogId: blog.id, publishPriority: 1 });
    await createArticle({ blogId: blog.id, publishPriority: 2 });
    await refreshProposalsForUser(userId, { now: NOW });

    const before = await listApprovalSummariesForUser(userId);
    const answered = before[0];

    await prisma.approval.update({
      where: { id: answered?.id },
      data: { status: 'APPROVED', respondedAt: NOW },
    });

    const after = await listApprovalSummariesForUser(userId);

    expect(after[0]?.id).not.toBe(answered?.id);
    expect(approvalTabOf(after[1]?.status ?? '')).toBe('APPROVED');
  });
});
