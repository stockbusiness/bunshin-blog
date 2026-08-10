/**
 * 承認・修正依頼・見送り（TASKS F-6、SPEC 13.6）。
 *
 * > 承認処理は**トランザクションと冪等性**を持たせる（SPEC 13.6）
 *
 * ## 冪等性の形
 *
 * **同じ答えを二度送っても成功する。** LINE の通信は落ちるし、
 * モニターは二度押す。二度目にエラーを返すと「押せていない」と思って
 * 三度押す。
 *
 * **違う答えは受け付けない。** 承認した提案を見送りへ変えられると、
 * 何を承認したのかが分からなくなる（409）。
 *
 * ## トランザクションの形
 *
 * 承認の記録と記事の状態は**同時に決まる**。片方だけ残ると、
 * 承認済みなのに `PLANNED` の記事や、その逆が生まれる。
 * `revision_requests` の行も同じトランザクションに入れる。
 */

import { prisma } from '@/lib/db';
import { setItemStatusInTx } from '@/modules/content-planning';
import { findApprovalForUser, type AppApproval } from './repository';
import {
  approvalAlreadyDecidedError,
  approvalNotFoundError,
  invalidRevisionRequestError,
} from './errors';

/** まだ答えていない状態（ここからしか決められない） */
const UNDECIDED = ['PENDING', 'VIEWED'] as const;

/** 修正依頼の種類（SPEC 5.15） */
export const REVISION_REQUEST_TYPES = [
  'SHORTER',
  'SOFTER',
  'CHANGE_TITLE',
  'CHANGE_PRODUCT',
  'FACT_ERROR',
  'FREE_TEXT',
] as const;

export type RevisionRequestType = (typeof REVISION_REQUEST_TYPES)[number];

export const REVISION_COMMENT_MAX_LENGTH = 1_000;

export interface DecideInput {
  userId: string;
  approvalId: string;
  now?: Date | undefined;
}

/**
 * 開いたことを記録する（`POST /api/approvals/:id/view`）。
 *
 * **`viewed_at` は最初に開いた時刻のまま。**「いつ気づいたか」の記録で、
 * 開くたびに更新すると意味が変わる。既に答えた提案は動かさない。
 *
 * @throws {AppError} 自分の承認でない
 */
export async function markViewedForUser(
  input: DecideInput,
): Promise<AppApproval> {
  const found = await requireOwn(input);

  if (found.status !== 'PENDING') {
    // **二度目も成功。** 「開いた」は取り消せる操作ではない
    return found;
  }

  await prisma.approval.updateMany({
    where: { id: input.approvalId, userId: input.userId, status: 'PENDING' },
    data: { status: 'VIEWED', viewedAt: input.now ?? new Date() },
  });

  return readBack(input.approvalId);
}

/**
 * 承認する（`POST /api/approvals/:id/approve`）。
 *
 * 記事を `APPROVED` にする。**投稿はしない** — WordPress への連携は F-7。
 */
export async function approveForUser(input: DecideInput): Promise<AppApproval> {
  return decide({ ...input, to: 'APPROVED', itemStatus: 'APPROVED' });
}

/**
 * 見送る（`POST /api/approvals/:id/skip`）。
 *
 * 記事を `REJECTED` にする。**同じ版は二度提案されない**
 * （`approvals.article_version_id` の一意制約。F-1-schema）。
 */
export async function skipForUser(input: DecideInput): Promise<AppApproval> {
  return decide({ ...input, to: 'SKIPPED', itemStatus: 'REJECTED' });
}

export interface RevisionInput extends DecideInput {
  requestType: RevisionRequestType;
  comment?: string | undefined;
}

/**
 * 修正を依頼する（`POST /api/approvals/:id/revision`）。
 *
 * 記事を `PLANNED` へ戻す。**次の版を作り直すため** —
 * `article_versions` は上書きしないので（E-10）、作り直せば新しい版になり、
 * その版に対して改めて提案が作られる（F-1）。
 *
 * @throws {AppError} 自由記述なのに本文が無い・自分の承認でない
 */
export async function requestRevisionForUser(
  input: RevisionInput,
): Promise<AppApproval> {
  const comment = input.comment?.trim() ?? '';

  // **`FREE_TEXT` は本文が要る。** 何を直すか分からない依頼を残さない
  if (input.requestType === 'FREE_TEXT' && comment === '') {
    throw invalidRevisionRequestError('修正の内容を書いてください');
  }

  if (comment.length > REVISION_COMMENT_MAX_LENGTH) {
    throw invalidRevisionRequestError(
      `修正の内容は${REVISION_COMMENT_MAX_LENGTH}文字以内で書いてください`,
    );
  }

  return decide({
    userId: input.userId,
    approvalId: input.approvalId,
    ...(input.now === undefined ? {} : { now: input.now }),
    to: 'REVISION_REQUESTED',
    itemStatus: 'PLANNED',
    revision: {
      requestType: input.requestType,
      comment: comment === '' ? null : comment,
    },
  });
}

async function decide(params: {
  userId: string;
  approvalId: string;
  now?: Date | undefined;
  to: 'APPROVED' | 'SKIPPED' | 'REVISION_REQUESTED';
  itemStatus: string;
  revision?:
    { requestType: RevisionRequestType; comment: string | null } | undefined;
}): Promise<AppApproval> {
  const found = await requireOwn(params);

  // **同じ答えなら成功。** 二度押しでエラーを返すと三度押される
  if (found.status === params.to) {
    return found;
  }

  // **違う答えは受け付けない。** 承認した提案を見送りへ変えられると、
  // 何を承認したのかが分からなくなる
  if (!(UNDECIDED as readonly string[]).includes(found.status)) {
    throw approvalAlreadyDecidedError(found.status);
  }

  const now = params.now ?? new Date();

  await prisma.$transaction(async (tx) => {
    const updated = await tx.approval.updateMany({
      where: {
        id: params.approvalId,
        userId: params.userId,
        // **状態を条件に入れる。** 同時に2回来ても片方しか通らない
        status: { in: [...UNDECIDED] },
      },
      data: { status: params.to as never, respondedAt: now },
    });

    if (updated.count === 0) {
      // 直前に別の実行が決めた。**やり直させず、読み直して返す**
      return;
    }

    if (params.revision !== undefined) {
      await tx.revisionRequest.create({
        data: {
          approvalId: params.approvalId,
          requestType: params.revision.requestType as never,
          comment: params.revision.comment,
        },
      });
    }

    await setItemStatusInTx(tx, {
      contentItemId: found.contentItemId,
      // **承認待ちからのみ動かす。** 既に投稿された記事を巻き戻さない
      from: ['READY_FOR_REVIEW'],
      to: params.itemStatus,
    });
  });

  return readBack(params.approvalId);
}

async function requireOwn(params: {
  userId: string;
  approvalId: string;
}): Promise<AppApproval> {
  const found = await findApprovalForUser(params);

  if (found === null) {
    throw approvalNotFoundError();
  }

  return found.approval;
}

async function readBack(approvalId: string): Promise<AppApproval> {
  const row = await prisma.approval.findUniqueOrThrow({
    where: { id: approvalId },
    select: {
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
    },
  });

  return row;
}

/** 修正依頼の一覧（承認画面と次の生成で使う） */
export async function listRevisionRequestsForUser(params: {
  userId: string;
  approvalId: string;
}): Promise<
  { id: string; requestType: string; comment: string | null; createdAt: Date }[]
> {
  await requireOwn(params);

  return prisma.revisionRequest.findMany({
    where: { approvalId: params.approvalId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, requestType: true, comment: true, createdAt: true },
  });
}

/** 入力が修正依頼の種類かどうか */
export function isRevisionRequestType(
  value: unknown,
): value is RevisionRequestType {
  return (
    typeof value === 'string' &&
    (REVISION_REQUEST_TYPES as readonly string[]).includes(value)
  );
}
