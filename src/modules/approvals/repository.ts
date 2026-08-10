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
