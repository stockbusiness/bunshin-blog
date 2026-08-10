/**
 * `approvals` テーブルへのアクセス（TASKS F-1）。
 *
 * **このモジュールだけが `approvals` を触る**（MODULE_RULES 1）。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

export interface AppApproval {
  id: string;
  userId: string;
  blogId: string;
  contentItemId: string;
  articleVersionId: string;
  status: string;
  proposalType: string;
  priorityScore: number;
  proposalReason: string;
  sentAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  userId: true,
  blogId: true,
  contentItemId: true,
  articleVersionId: true,
  status: true,
  proposalType: true,
  priorityScore: true,
  proposalReason: true,
  sentAt: true,
  createdAt: true,
} as const;

/** まだ返事の無い提案（SPEC 5.14 の状態） */
const OPEN_STATUSES = ['PENDING', 'VIEWED'] as const;

export interface BlogApprovalHistory {
  blogId: string;
  lastProposedAt: Date | null;
  openProposalCount: number;
}

/**
 * ブログごとの提案の履歴を引く（F-1 の点付けに使う）。
 *
 * **`userId` を条件に入れる。** `blogIds` は呼び出し側が用意するが、
 * ここでも利用者で絞る（C-6 と同じ形の穴を作らない）。
 */
export async function listBlogApprovalHistoryForUser(
  userId: string,
  blogIds: readonly string[],
): Promise<BlogApprovalHistory[]> {
  if (blogIds.length === 0) {
    return [];
  }

  const [latest, open] = await Promise.all([
    prisma.approval.groupBy({
      by: ['blogId'],
      where: { userId, blogId: { in: [...blogIds] } },
      _max: { createdAt: true },
    }),
    prisma.approval.groupBy({
      by: ['blogId'],
      where: {
        userId,
        blogId: { in: [...blogIds] },
        status: { in: [...OPEN_STATUSES] },
      },
      _count: { _all: true },
    }),
  ]);

  const lastByBlog = new Map(
    latest.map((row) => [row.blogId, row._max.createdAt]),
  );
  const openByBlog = new Map(open.map((row) => [row.blogId, row._count._all]));

  return blogIds.map((blogId) => ({
    blogId,
    lastProposedAt: lastByBlog.get(blogId) ?? null,
    openProposalCount: openByBlog.get(blogId) ?? 0,
  }));
}

export interface CreateApprovalInput {
  userId: string;
  blogId: string;
  contentItemId: string;
  articleVersionId: string;
  proposalType: string;
  priorityScore: number;
  proposalReason: string;
}

/**
 * 提案を作る。
 *
 * **既に同じ版の提案があれば作らない。** 一意制約（F-1-schema）が
 * 最後の砦だが、その違反を握り潰さずここで「作らなかった」と返す —
 * 同時に2回走ったときに、片方だけが落ちて全体が失敗するのを避ける。
 *
 * @returns 作れたら提案、既にあれば `null`
 */
export async function createApproval(
  input: CreateApprovalInput,
): Promise<AppApproval | null> {
  try {
    return await prisma.approval.create({
      data: {
        userId: input.userId,
        blogId: input.blogId,
        contentItemId: input.contentItemId,
        articleVersionId: input.articleVersionId,
        status: 'PENDING',
        proposalType: input.proposalType as never,
        priorityScore: input.priorityScore,
        proposalReason: input.proposalReason,
      },
      select: SELECT,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * 自分の提案を優先度の高い順に返す。
 *
 * **同点は作成の新しい順、最後は `id`。** 呼ぶたびに順番が入れ替わると、
 * 承認一覧（F-4）で行が動く。
 */
export async function listApprovalsForUser(
  userId: string,
  options: { openOnly?: boolean } = {},
): Promise<AppApproval[]> {
  return prisma.approval.findMany({
    where: {
      userId,
      ...(options.openOnly === true
        ? { status: { in: [...OPEN_STATUSES] } }
        : {}),
    },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: SELECT,
  });
}

export interface UnsentApproval {
  id: string;
  blogId: string;
  blogName: string;
  articleTitle: string;
  proposalReason: string;
  priorityScore: number;
}

/**
 * まだ通知していない提案を、優先度の高い順に引く（F-2）。
 *
 * **`sent_at` が空のものだけ。** SPEC 8.3 の「同一提案を連続通知しない」は
 * ここと `claimApprovalForSending` の2段で守る。
 */
export async function listUnsentApprovalsForUser(
  userId: string,
): Promise<UnsentApproval[]> {
  const rows = await prisma.approval.findMany({
    where: { userId, status: 'PENDING', sentAt: null },
    orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      blogId: true,
      proposalReason: true,
      priorityScore: true,
      blog: { select: { name: true } },
      articleVersion: { select: { title: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    blogId: row.blogId,
    blogName: row.blog.name,
    articleTitle: row.articleVersion.title,
    proposalReason: row.proposalReason,
    priorityScore: row.priorityScore,
  }));
}

/**
 * 送信する提案を1件押さえる（F-2 の完了条件「同一提案を連続通知しない」）。
 *
 * **送る前に `sent_at` を立てる。** 送ってから立てると、送信の直後に
 * 落ちたときに二度届く。逆にすると「立てたが送れなかった」が起こりうるが、
 * **提案は承認一覧（F-4）に残る**ので消えはしない。
 * SPEC 8.3 が禁じているのは重複通知のほうである。
 *
 * `updateMany` の条件に `sent_at: null` を入れることで、
 * **同時に2回走っても片方しか押さえられない**。
 *
 * @returns 押さえられたら `true`
 */
export async function claimUnsentApprovalForUser(params: {
  userId: string;
  approvalId: string;
  now: Date;
}): Promise<boolean> {
  const updated = await prisma.approval.updateMany({
    where: { id: params.approvalId, userId: params.userId, sentAt: null },
    data: { sentAt: params.now },
  });

  return updated.count === 1;
}

/**
 * その日に通知した提案の件数を数える（F-3、SPEC 8.3）。
 *
 * **ブログで絞らない。** SPEC 8.3 の「3ブログ合計で制限」は、
 * 数える単位が利用者だということ。ブログごとに数えると、
 * 3ブログ持つ人には1日3件届く。
 *
 * **緊急通知は入らない。** 緊急通知は `approvals` の行を作らないため、
 * ここで数えようがない（SPEC 8.3「緊急通知は別枠」）。
 */
export async function countProposalsSentInRangeForUser(params: {
  userId: string;
  from: Date;
  to: Date;
}): Promise<number> {
  return prisma.approval.count({
    where: {
      userId: params.userId,
      sentAt: { gte: params.from, lt: params.to },
    },
  });
}

export interface ApprovalSummary {
  id: string;
  blogId: string;
  blogName: string;
  articleTitle: string;
  status: string;
  proposalType: string;
  proposalReason: string;
  priorityScore: number;
  /** 事実チェックの結果。一覧で「確認が要る」ことを先に示す（E-12） */
  factCheckStatus: string;
  /** `warning` のリスクフラグの件数（E-13） */
  riskFlagCount: number;
  sentAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
}

/**
 * 承認一覧に出す一式を引く（F-4、SPEC 6.1 `/liff/approvals`）。
 *
 * **`userId` だけを入口にする。** 一覧の絞り込みをクエリで受けない
 * （SPEC 14.1）。並べ分けは画面側（`approvalTabOf`）。
 *
 * **返事の済んだものは新しい順、待ちは優先度順。** 待っているものは
 * 「どれから見るか」が要り、済んだものは「いつのことか」が要る。
 */
export async function listApprovalSummariesForUser(
  userId: string,
): Promise<ApprovalSummary[]> {
  const rows = await prisma.approval.findMany({
    where: { userId },
    orderBy: [
      { respondedAt: { sort: 'asc', nulls: 'first' } },
      { priorityScore: 'desc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    select: {
      id: true,
      blogId: true,
      status: true,
      proposalType: true,
      proposalReason: true,
      priorityScore: true,
      sentAt: true,
      respondedAt: true,
      createdAt: true,
      blog: { select: { name: true } },
      articleVersion: {
        select: { title: true, factCheckStatus: true, riskFlags: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    blogId: row.blogId,
    blogName: row.blog.name,
    articleTitle: row.articleVersion.title,
    status: row.status,
    proposalType: row.proposalType,
    proposalReason: row.proposalReason,
    priorityScore: row.priorityScore,
    factCheckStatus: row.articleVersion.factCheckStatus,
    riskFlagCount: countWarningFlags(row.articleVersion.riskFlags),
    sentAt: row.sentAt,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  }));
}

/**
 * `warning` のリスクフラグを数える。
 *
 * **形が違えば0にせず、読めた分だけ数える。** `error` は F-1 の時点で
 * 提案にならないため、ここに来るのは `warning` と `info` だけ。
 */
function countWarningFlags(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }

  return value.filter(
    (entry) => (entry as { severity?: string })?.severity === 'warning',
  ).length;
}

export interface FoundApproval {
  approval: AppApproval;
  blogName: string;
  slotNumber: number;
  offerId: string | null;
}

/**
 * 自分の承認を1件引く（F-5）。
 *
 * **`userId` を条件に入れる。** `approvalId` は画面から渡ってくる。
 * 他人のものは `null`（「無い」と区別しない。SPEC 14.1）。
 */
export async function findApprovalForUser(params: {
  userId: string;
  approvalId: string;
}): Promise<FoundApproval | null> {
  const row = await prisma.approval.findFirst({
    where: { id: params.approvalId, userId: params.userId },
    select: {
      ...SELECT,
      blog: { select: { name: true, slotNumber: true } },
      contentItem: { select: { affiliateOfferId: true } },
    },
  });

  if (row === null) {
    return null;
  }

  const { blog, contentItem, ...approval } = row;

  return {
    approval,
    blogName: blog.name,
    slotNumber: blog.slotNumber,
    offerId: contentItem.affiliateOfferId,
  };
}
