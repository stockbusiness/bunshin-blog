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
 * ## 1日の件数は利用者単位で数える（F-3、SPEC 8.3）
 *
 * 「3ブログ合計で制限」は、**数える単位が利用者だということ**。
 * ブログごとに1日1件にすると、3ブログ持つ人には1日3件届く。
 *
 * 数えるのは **JSTの暦日**。UTCで数えると日本の1日が2日にまたがり、
 * 夜に届いた1件が翌日の枠を1つ消す。
 *
 * **緊急通知は別枠**（`sendEmergencyNotificationForUser`）。
 * `approvals` の行を作らないので、この計算に入りようがない。
 */

import { jstDayRange, todayInJst } from '@/lib/datetime';
import { requireLineClient, type LineClient } from '@/lib/line';
import { logger } from '@/lib/logger';
import {
  claimUnsentApprovalForUser,
  countProposalsSentInRangeForUser,
  expireStaleUnsentApprovalsForUser,
  listUnsentApprovalsForUser,
  type UnsentApproval,
} from '@/modules/approvals';
import { enqueueJob } from '@/modules/jobs';
import { getRuntimeEnv } from '@/modules/settings';
import {
  findMaxDailyProposalsForUser,
  findNotificationScheduleForUser,
  findNotificationTargetForUser,
  fromNotificationTimeColumn,
} from '@/modules/users';
import {
  alertIdempotencyKey,
  collectAlertsForUser,
  type BlogAlert,
} from './alerts';
import { dailyNotificationLimit, remainingNotificationSlots } from './limit';
import {
  UNSENT_PROPOSAL_TTL_DAYS,
  isWithinNotificationWindow,
} from './schedule';
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
  /** その日に送ってよい残り枠（送信前の値。SPEC 8.3） */
  remaining: number;
  /**
   * いま送ってよい時間帯だったか（F-3b・Q-025）。
   *
   * **`false` と「送るものが無い」を呼び出し側が区別できるようにする。**
   * どちらも `sent` が空になるが、原因も次にすべきことも違う
   */
  inWindow: boolean;
  /** 古くなって期限切れにした件数（F-3b） */
  expired: number;
}

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
  const now = deps.now ?? new Date();

  // **古いものを先に落とす**（F-3b・Q-025）。時間帯の判定より前に置く —
  // 通知日でない日にも掃除が進み、**通知日に溜まった山を見せない**
  const expired = await expireStaleUnsentApprovalsForUser({
    userId,
    before: new Date(now.getTime() - UNSENT_PROPOSAL_TTL_DAYS * 86_400_000),
  });

  // **枠を先に数える。** 提案が無くても残り枠は返す（呼び出し側が
  // 「今日はもう送れない」と「送るものが無い」を区別できるように）
  const remaining = await remainingSlotsForUser(userId, now);

  // **指定の曜日・時刻にだけ送る**（F-3b・SPEC 8.3）。
  // 押さえる前に判定する — `sent_at` を立ててから弾くと、
  // **送っていない提案が送信済みとして残る**
  const saved = await findNotificationScheduleForUser(userId);
  const inWindow = isWithinNotificationWindow({
    schedule:
      saved === null
        ? null
        : {
            days: saved.days,
            time: fromNotificationTimeColumn(saved.time),
          },
    now,
  });

  if (!inWindow) {
    return { sent: [], skipped: 0, remaining, inWindow: false, expired };
  }

  const pending = await listUnsentApprovalsForUser(userId);

  if (pending.length === 0 || remaining === 0) {
    return { sent: [], skipped: 0, remaining, inWindow: true, expired };
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

  // **上限は残り枠を超えられない。** 呼び出し側の指定は「それ以下に
  // 絞る」ためだけに効く
  const limit = Math.min(options.limit ?? remaining, remaining);
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

  return { sent, skipped, remaining, inWindow: true, expired };
}

/**
 * その日に送ってよい残り枠を返す（SPEC 8.3）。
 *
 * **ブログで絞らない。**「3ブログ合計で制限」は数える単位が利用者だということ。
 */
export async function remainingSlotsForUser(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  // **JSTの暦日で数える。** UTCで数えると日本の1日が2日にまたがる
  const range = jstDayRange(todayInJst(now));

  const [maxDaily, sentToday] = await Promise.all([
    findMaxDailyProposalsForUser(userId),
    countProposalsSentInRangeForUser({
      userId,
      from: range.start,
      to: range.endExclusive,
    }),
  ]);

  return remainingNotificationSlots({
    limit: dailyNotificationLimit(maxDaily),
    sentToday,
  });
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

/**
 * 緊急通知の種類（SPEC 8.3）。
 *
 * ```text
 * - リンク切れ
 * - 案件終了
 * - WordPress接続切れ
 * ```
 *
 * **提案ではないので `approvals` の行を作らない。** 作らないことが
 * そのまま「別枠」になる — 1日の件数を数えているのは `approvals.sent_at`
 * であり、ここを通った通知は数えようがない。
 */
export type EmergencyKind =
  'LINK_BROKEN' | 'OFFER_ENDED' | 'WORDPRESS_DISCONNECTED';

const EMERGENCY_LABELS: Readonly<Record<EmergencyKind, string>> = {
  LINK_BROKEN: 'リンク切れ',
  OFFER_ENDED: '案件終了',
  WORDPRESS_DISCONNECTED: 'WordPress接続切れ',
};

/**
 * 緊急通知を送る（SPEC 8.3「緊急通知は別枠」）。
 *
 * **1日の件数を消費しない。** 提案の枠と同じ数え方にすると、
 * 「今日は1件送ったので接続切れを知らせない」が起きる。
 *
 * 中身を作るのは H-3。ここでは**別枠であること**だけを用意する。
 *
 * @throws {AppError} LINE の設定が無い・宛先が無い
 */
export async function sendEmergencyNotificationForUser(
  userId: string,
  input: { kind: EmergencyKind; blogName: string; detail: string },
  deps: SendProposalsDeps = {},
): Promise<void> {
  const env = deps.env ?? (await getRuntimeEnv());

  const to = await findNotificationTargetForUser(userId);

  if (to === null) {
    throw notificationTargetMissingError();
  }

  const client = deps.client ?? createClient(env);

  await client.push({
    to,
    messages: [
      {
        type: 'text',
        text: [
          `【${input.blogName}】${EMERGENCY_LABELS[input.kind]}`,
          input.detail,
        ].join('\n'),
      },
    ],
  });
}

/**
 * 見つけた指摘を通知として積む（H-3）。
 *
 * **その場で送らずジョブにする。** 検出はブログごとにHTTPを叩くため
 * 時間がかかり、途中で落ちると「一部だけ送った」状態になる。
 * 積んでおけば、送信の失敗は再試行される（C-4）。
 *
 * **同じ日の同じ指摘は1回だけ**（冪等キーに日付を入れる）。
 * 直っていなければ翌日また届く — 直すまで思い出させるのは正しい。
 *
 * @returns 新しく積んだ件数
 */
export async function enqueueAlertsForUser(
  userId: string,
  deps: { now?: Date | undefined; alerts?: BlogAlert[] | undefined } = {},
): Promise<number> {
  const now = deps.now ?? new Date();
  const alerts = deps.alerts ?? (await collectAlertsForUser(userId));

  let queued = 0;

  for (const alert of alerts) {
    const result = await enqueueJob({
      jobType: 'LINE_NOTIFY',
      idempotencyKey: alertIdempotencyKey({ alert, now }),
      input: {
        kind: alert.kind,
        blogName: alert.blogName,
        detail: alert.detail,
      },
      userId,
      blogId: alert.blogId,
    });

    if (result.created) {
      queued += 1;
    }
  }

  return queued;
}

/**
 * リンク切れの確認を積む（TASKS I-1、SPEC 4「リンク切れ確認」ジョブ）。
 *
 * **1日1回。** 冪等キーにJSTの暦日を入れるので、cron が何度呼んでも
 * その日は1件しか積まれない（C-4）。
 *
 * **利用者単位で積む。** 確認そのものはブログごとだが、通知は利用者へ
 * まとめて出す（`enqueueAlertsForUser` が同じ日の同じ指摘を1回にする）。
 *
 * @returns 新しく積んだなら `true`
 */
export async function enqueueLinkCheckForUser(
  userId: string,
  deps: { now?: Date | undefined } = {},
): Promise<boolean> {
  const date = todayInJst(deps.now ?? new Date());

  const result = await enqueueJob({
    jobType: 'LINK_CHECK',
    idempotencyKey: `LINK_CHECK:${userId}:${date}`,
    input: {},
    userId,
  });

  return result.created;
}
