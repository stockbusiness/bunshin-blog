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
