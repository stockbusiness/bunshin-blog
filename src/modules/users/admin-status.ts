/**
 * モニターの状態をADMINが変える（TASKS H-1、SPEC 6.2 `/admin/users`）。
 *
 * 完了条件は「**招待〜ACTIVE化が管理画面で完結**」。
 *
 * ## 誰が `INVITED` を作るのか
 *
 * `users.status` の既定は `INVITED` で、LIFF から登録した時点でその状態に
 * なる（B-2 の `findOrCreateByLineUserId`）。**`INVITED` のままでは
 * アプリを使えない**（`requireConsentedUser` が `isActiveUser` で弾く）。
 *
 * つまり実験への参加は「登録できた」ではなく「**ADMIN が認めた**」で決まる。
 * ここはその1操作。
 *
 * **招待そのもの（声をかけて登録してもらう）をアプリの機能にするかは
 * 未解決**（Q-026）。
 *
 * ## 退会はここではない
 *
 * `WITHDRAWN` への遷移は H-4。**戻せない操作を同じ画面の同じ並びに
 * 置かない** — 停止のつもりで退会させる事故を避ける。
 *
 * **ADMIN 専用。`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 */

import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { recordAuditInTx, type AuditAction } from '@/modules/audit';
import type { AppUser } from './types';

export const USER_ADMIN_ERROR_CODES = {
  /** モニターが見つからない */
  notFound: 'MONITOR_NOT_FOUND',
  /** その状態からは変えられない */
  invalidTransition: 'MONITOR_INVALID_TRANSITION',
} as const;

export type UserAdminErrorCode =
  (typeof USER_ADMIN_ERROR_CODES)[keyof typeof USER_ADMIN_ERROR_CODES];

function notFoundError(): AppError {
  return new AppError(
    USER_ADMIN_ERROR_CODES.notFound,
    404,
    'モニターが見つかりません',
  );
}

/**
 * 遷移できないことを表す。
 *
 * **今の状態を文面に入れる。** 画面が古いまま押されたときに、
 * 何が起きたのかが分かる。
 */
function invalidTransitionError(current: string): AppError {
  return new AppError(
    USER_ADMIN_ERROR_CODES.invalidTransition,
    409,
    `この状態からは変更できません（${current}）`,
  );
}

/** ADMIN が変えられる状態（`WITHDRAWN` は H-4） */
export type MonitorAdminAction = 'ACTIVATE' | 'PAUSE' | 'RESUME';

/**
 * それぞれの操作で、どの状態から どの状態へ動かすか。
 *
 * **表にして1箇所に置く。** 条件分岐に散らすと、
 * 「停止中を承認できてしまう」ような穴が後から入る。
 */
const TRANSITIONS: Readonly<
  Record<
    MonitorAdminAction,
    { from: readonly string[]; to: string; audit: AuditAction }
  >
> = {
  // **`ACTIVE` からの `ACTIVATE` も通す**（冪等）。二度押しで落とさない
  ACTIVATE: {
    from: ['INVITED', 'ACTIVE'],
    to: 'ACTIVE',
    audit: 'MONITOR_ACTIVATED',
  },
  PAUSE: {
    from: ['ACTIVE', 'PAUSED'],
    to: 'PAUSED',
    audit: 'MONITOR_PAUSED',
  },
  // **`INVITED` を `RESUME` で `ACTIVE` にしない。** 認めるのは `ACTIVATE`
  RESUME: {
    from: ['PAUSED', 'ACTIVE'],
    to: 'ACTIVE',
    audit: 'MONITOR_RESUMED',
  },
};

/** その操作が今の状態に対して意味を持つか（画面のボタンの出し分けに使う） */
export function canApplyMonitorAction(params: {
  action: MonitorAdminAction;
  status: string;
}): boolean {
  return TRANSITIONS[params.action].from.includes(params.status);
}

/**
 * モニターの状態を変える。
 *
 * **同じ状態への操作は成功させる**（冪等）。管理画面は複数人が開きうる。
 *
 * **`MONITOR` だけを対象にする。** ADMIN 同士で停止し合えると、
 * 誰も管理画面に入れない状態を作れる。
 *
 * @throws {AppError} 見つからない・その状態からは変えられない
 */
export async function updateMonitorStatusForAdmin(params: {
  userId: string;
  action: MonitorAdminAction;
  /** 操作したADMIN。**誰が介入したかを残す**（H-11） */
  actorUserId: string | null;
}): Promise<AppUser> {
  const transition = TRANSITIONS[params.action];

  const current = await prisma.user.findFirst({
    where: { id: params.userId, role: 'MONITOR' },
    select: { status: true },
  });

  if (current === null) {
    throw notFoundError();
  }

  if (!transition.from.includes(current.status)) {
    throw invalidTransitionError(current.status);
  }

  // **介入と記録は同時に決まる**（H-11、Q-008 の決定）。
  // 記録だけ残って状態が戻る、あるいはその逆を作らない
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: params.userId },
      data: { status: transition.to as never },
      select: {
        id: true,
        role: true,
        displayName: true,
        status: true,
        termsAcceptedAt: true,
        dataUseConsentAt: true,
      },
    });

    await recordAuditInTx(tx, {
      actorUserId: params.actorUserId,
      action: transition.audit,
      entityType: 'user',
      entityId: params.userId,
      // **氏名や `line_user_id` を入れない**（SPEC 14.2）。
      // どこからどこへ動いたかだけを残す
      metadata: { from: current.status, to: transition.to },
    });

    return user;
  });

  return {
    id: updated.id,
    role: updated.role as AppUser['role'],
    displayName: updated.displayName,
    status: updated.status as AppUser['status'],
    termsAcceptedAt: updated.termsAcceptedAt,
    dataUseConsentAt: updated.dataUseConsentAt,
  };
}

/** 入力が操作の名前かどうか */
export function isMonitorAdminAction(
  value: unknown,
): value is MonitorAdminAction {
  return value === 'ACTIVATE' || value === 'PAUSE' || value === 'RESUME';
}
