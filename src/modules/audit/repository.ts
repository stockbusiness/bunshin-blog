/**
 * `audit_logs` テーブルへのアクセス（TASKS H-11、SPEC 5.20）。
 *
 * **このモジュールだけが `audit_logs` を触る**（MODULE_RULES 1）。
 *
 * ## 記録の失敗で本体を止めない
 *
 * 監査ログは「後から辿るため」のもので、**それが書けないことを理由に
 * モニターの操作を失敗させると、本末転倒**になる。書けなかったことは
 * ログに残し、処理は続ける。
 *
 * ただし**トランザクションの中から呼ぶ経路は別**（`recordAuditInTx`）。
 * そちらは本体と一緒に巻き戻る — 起きなかったことを記録しないため。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { AppAuditLog, RecordAuditInput } from './types';

const SELECT = {
  id: true,
  actorUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  createdAt: true,
} as const;

function toData(input: RecordAuditInput) {
  return {
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
  };
}

/**
 * 監査ログを書く。
 *
 * **失敗しても投げない。** 呼び出し側の処理は既に済んでいることが多く、
 * ここで例外にすると「操作は成功したのにエラーが返る」ことになる。
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({ data: toData(input) });
  } catch (error) {
    // **何が書けなかったかだけを残す。** `metadata` は出さない（SPEC 14.2）
    logger.error('監査ログを書けなかった', {
      action: input.action,
      entityType: input.entityType,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * トランザクションの中で監査ログを書く。
 *
 * **本体と一緒に巻き戻る。** 起きなかったことを記録しない。
 * こちらは握り潰さない — 巻き戻すべきものが巻き戻るのが正しい。
 */
export async function recordAuditInTx(
  tx: Prisma.TransactionClient,
  input: RecordAuditInput,
): Promise<void> {
  await tx.auditLog.create({ data: toData(input) });
}

/**
 * 監査ログを新しい順に返す（ADMIN 専用）。
 *
 * **`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 * 名前で横断参照であることを示す。
 */
export async function listAuditLogsForAdmin(
  options: { entityType?: string; entityId?: string; limit?: number } = {},
): Promise<AppAuditLog[]> {
  return prisma.auditLog.findMany({
    where: {
      ...(options.entityType === undefined
        ? {}
        : { entityType: options.entityType }),
      ...(options.entityId === undefined ? {} : { entityId: options.entityId }),
    },
    // `created_at` はミリ秒までしか持たない。同じミリ秒に並ぶと前後が
    // 決まらないので `id` を最後の決め手にする
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(1, options.limit ?? 100), 500),
    select: SELECT,
  });
}
