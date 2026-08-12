import { prisma } from '@/lib/db';
import type { AppUser, ConsentKind } from './types';

/**
 * `users` テーブルへのアクセス（B-2）。
 *
 * **このモジュールだけが `users` テーブルを触る**（MODULE_RULES 1）。
 * 他モジュールは `src/modules/users` の公開関数を経由する。
 */

/** テストから差し替えるための最小のDBインターフェース */
export interface UsersDb {
  findUnique(args: {
    where: { lineUserId: string };
  }): Promise<UserRecord | null>;
  findUniqueById(args: { where: { id: string } }): Promise<UserRecord | null>;
  create(args: {
    data: { lineUserId: string; displayName: string };
  }): Promise<UserRecord>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<UserRecord>;
}

interface UserRecord {
  id: string;
  role: string;
  displayName: string;
  status: string;
  termsAcceptedAt: Date | null;
  dataUseConsentAt: Date | null;
}

function toAppUser(record: UserRecord): AppUser {
  return {
    id: record.id,
    role: record.role as AppUser['role'],
    displayName: record.displayName,
    status: record.status as AppUser['status'],
    termsAcceptedAt: record.termsAcceptedAt,
    dataUseConsentAt: record.dataUseConsentAt,
  };
}

const prismaUsersDb: UsersDb = {
  findUnique: (args) => prisma.user.findUnique(args),
  findUniqueById: (args) => prisma.user.findUnique(args),
  create: (args) => prisma.user.create(args),
  update: (args) => prisma.user.update(args),
};

export interface UsersDeps {
  db?: UsersDb;
  now?: () => Date;
}

function resolveDb(deps: UsersDeps): UsersDb {
  return deps.db ?? prismaUsersDb;
}

/** `line_user_id` からユーザーを引く。未登録なら null */
export async function findByLineUserId(
  lineUserId: string,
  deps: UsersDeps = {},
): Promise<AppUser | null> {
  const record = await resolveDb(deps).findUnique({ where: { lineUserId } });

  return record === null ? null : toAppUser(record);
}

/** IDからユーザーを引く。セッションの復元に使う */
export async function findById(
  id: string,
  deps: UsersDeps = {},
): Promise<AppUser | null> {
  const record = await resolveDb(deps).findUniqueById({ where: { id } });

  return record === null ? null : toAppUser(record);
}

/**
 * メールアドレスから ADMIN を引く（B-11）。
 *
 * **`role = 'ADMIN'` の行だけを返す。** MONITOR のアドレスに管理画面の
 * ログインリンクを送らないため、絞り込みをここで行う。
 *
 * **見つからない理由を区別しない。** 「未登録」と「MONITOR だった」を
 * 呼び出し側へ伝えると、どのアドレスが管理者かを外から調べられる。
 */
export async function findAdminByEmail(email: string): Promise<AppUser | null> {
  const normalized = email.trim().toLowerCase();
  if (normalized === '') {
    return null;
  }

  const record = await prisma.user.findFirst({
    where: { email: normalized, role: 'ADMIN' },
    select: {
      id: true,
      role: true,
      displayName: true,
      status: true,
      termsAcceptedAt: true,
      dataUseConsentAt: true,
    },
  });

  return record === null ? null : toAppUser(record);
}

/**
 * `line_user_id` でユーザーを引き、無ければ作る。
 *
 * **`lineUserId` は検証済みのIDトークンから来たものだけを渡すこと**
 * （SPEC 3.2）。クライアントが送ってきた値を渡してはならない。
 *
 * 新規作成時の同意は空のまま。同意は本人の操作として別途記録する。
 */
export async function findOrCreateByLineUserId(
  lineUserId: string,
  displayName: string,
  deps: UsersDeps = {},
): Promise<{ user: AppUser; created: boolean }> {
  const existing = await findByLineUserId(lineUserId, deps);
  if (existing !== null) {
    return { user: existing, created: false };
  }

  const record = await resolveDb(deps).create({
    data: { lineUserId, displayName },
  });

  return { user: toAppUser(record), created: true };
}

/**
 * 同意を記録する。
 *
 * 同意済みの場合は時刻を上書きしない。「いつ同意したか」は
 * データ利用の根拠になるため、後の操作で書き換えない。
 */
export async function recordConsent(
  userId: string,
  kind: ConsentKind,
  deps: UsersDeps = {},
): Promise<AppUser> {
  const now = (deps.now ?? (() => new Date()))();
  const current = await findById(userId, deps);

  if (current === null) {
    throw new Error(`ユーザーが見つかりません: ${userId}`);
  }

  const field = kind === 'terms' ? 'termsAcceptedAt' : 'dataUseConsentAt';
  if (current[field] !== null) {
    return current;
  }

  const record = await resolveDb(deps).update({
    where: { id: userId },
    data: { [field]: now },
  });

  return toAppUser(record);
}

/**
 * 通知の宛先を引く（F-2）。
 *
 * **`AppUser` に `line_user_id` を載せない。** 身元そのもので、
 * 画面へ渡る型に混ぜると出力先が増える（SPEC 14.2）。通知を送るときだけ
 * ここから取る。
 *
 * **`ACTIVE` 以外には送らない。** 停止・退会した利用者に提案が届くと、
 * 止めたはずのものが動いているように見える。
 *
 * @returns 送ってよければ `line_user_id`、そうでなければ `null`
 */
export async function findNotificationTargetForUser(
  userId: string,
): Promise<string | null> {
  const record = await prisma.user.findUnique({
    where: { id: userId },
    select: { lineUserId: true, status: true },
  });

  if (record === null || record.status !== 'ACTIVE') {
    return null;
  }

  return record.lineUserId;
}

/**
 * 1日に受け取る提案の上限を引く（F-3、SPEC 8.3）。
 *
 * **`monitor_profiles` が無ければ `null`。** 呼び出し側が既定へ落とす
 * （`dailyNotificationLimit`）。ここで既定値を持つと、上限の既定が
 * 2箇所になる。
 */
export async function findNotificationScheduleForUser(userId: string): Promise<{
  days: number[];
  time: Date;
} | null> {
  const profile = await prisma.monitorProfile.findUnique({
    where: { userId },
    select: { notificationDays: true, notificationTime: true },
  });

  // **曜日が空なら「未設定」。** 行はあるが1日も選ばれていない状態を
  // 設定済みにすると、通知が一度も飛ばないまま「済み」に見える
  if (profile === null || profile.notificationDays.length === 0) {
    return null;
  }

  return { days: profile.notificationDays, time: profile.notificationTime };
}

export async function findMaxDailyProposalsForUser(
  userId: string,
): Promise<number | null> {
  const profile = await prisma.monitorProfile.findUnique({
    where: { userId },
    select: { maxDailyProposals: true },
  });

  return profile?.maxDailyProposals ?? null;
}
