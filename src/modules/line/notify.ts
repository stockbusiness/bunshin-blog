/**
 * 提案のLINE通知（TASKS F-2、SPEC 8.1・8.2・8.3）。
 *
 * 完了条件は「**同一提案を連続通知しない**」。
 *
 * ## 二重通知を2段で止める
 *
 * 1. **送る前に `sent_at` を立てる**（`claimUnsentApprovalForUser`）。
 *    条件に `sent_at IS NULL` を入れるので、同時に2回走っても
 *    片方しか押さえられない
 * 2. **LINE へ `x-line-retry-key` を渡す**。再試行が届いても LINE 側で落ちる
 *
 * 「立てたが送れなかった」は起こりうる。**提案は承認一覧（F-4）に残る**ので
 * 消えはせず、SPEC 8.3 が禁じている重複通知のほうを避けている。
 *
 * ## 1日に何件送るかはここで決めない
 *
 * SPEC 8.3 の件数制御は F-3。ここは**渡された分を送る**だけにして、
 * 「送る条件」と「送る手順」を分けておく。
 */

import { requireLineClient, type LineClient } from '@/lib/line';
import { logger } from '@/lib/logger';
import {
  claimUnsentApprovalForUser,
  listUnsentApprovalsForUser,
  type UnsentApproval,
} from '@/modules/approvals';
import { getRuntimeEnv } from '@/modules/settings';
import { findNotificationTargetForUser } from '@/modules/users';
import { buildProposalMessages } from './message';
import {
  lineNotConfiguredError,
  notificationTargetMissingError,
} from './errors';

export interface SendProposalsDeps {
  client?: LineClient | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  now?: Date | undefined;
}

export interface SendProposalsResult {
  sent: string[];
  /** 押さえられなかった提案の件数（既に別の実行が送っている） */
  skipped: number;
}

/**
 * 通知する提案を選ぶ余地を呼び出し側へ残す。
 *
 * F-3 が件数制御を入れるまでは、**呼び出し側が `limit` を渡す**。
 * 既定を無制限にしないのは、初回に30件まとめて届くのを防ぐため。
 */
export const DEFAULT_NOTIFICATION_LIMIT = 1;

/**
 * まだ通知していない提案を送る。
 *
 * @throws {AppError} LINE の設定が無い・宛先が無い
 */
export async function sendPendingProposalsForUser(
  userId: string,
  options: { limit?: number | undefined } = {},
  deps: SendProposalsDeps = {},
): Promise<SendProposalsResult> {
  const pending = await listUnsentApprovalsForUser(userId);

  if (pending.length === 0) {
    return { sent: [], skipped: 0 };
  }

  const env = deps.env ?? (await getRuntimeEnv());
  const liffBaseUrl = env['LIFF_BASE_URL']?.trim() ?? '';

  if (liffBaseUrl === '') {
    throw lineNotConfiguredError(['LIFF_BASE_URL']);
  }

  // **宛先を先に確かめる。** 押さえてから宛先が無いと分かると、
  // 送っていない提案に `sent_at` が立ったまま残る
  const to = await findNotificationTargetForUser(userId);

  if (to === null) {
    throw notificationTargetMissingError();
  }

  const client = deps.client ?? createClient(env);
  const now = deps.now ?? new Date();

  const limit = options.limit ?? DEFAULT_NOTIFICATION_LIMIT;
  const targets = pending.slice(0, Math.max(0, limit));

  const sent: string[] = [];
  let skipped = 0;

  for (const approval of targets) {
    const claimed = await claimUnsentApprovalForUser({
      userId,
      approvalId: approval.id,
      now,
    });

    if (!claimed) {
      skipped += 1;

      continue;
    }

    await push({ client, to, approval, liffBaseUrl, userId });
    sent.push(approval.id);
  }

  return { sent, skipped };
}

function createClient(
  env: Readonly<Record<string, string | undefined>>,
): LineClient {
  try {
    return requireLineClient({ ...env });
  } catch {
    // **不足している変数名だけを見せる。** 値はログにも出さない（SPEC 14.2）
    throw lineNotConfiguredError(['LINE_CHANNEL_ACCESS_TOKEN']);
  }
}

async function push(params: {
  client: LineClient;
  to: string;
  approval: UnsentApproval;
  liffBaseUrl: string;
  userId: string;
}): Promise<void> {
  try {
    await params.client.push({
      to: params.to,
      messages: buildProposalMessages({
        approvalId: params.approval.id,
        blogName: params.approval.blogName,
        articleTitle: params.approval.articleTitle,
        proposalReason: params.approval.proposalReason,
        liffBaseUrl: params.liffBaseUrl,
      }),
      // **同じ提案を二度送らない**（SPEC 8.3）。LINE 側でも止める
      retryKey: params.approval.id,
    });
  } catch (cause) {
    // **押さえたまま投げる。** ここで戻すと、届いていた場合に二度送る。
    // ジョブが失敗として記録され、ADMIN へ通知される（E-1）
    logger.error('提案の通知に失敗した', { approvalId: params.approval.id });

    throw cause;
  }
}
