/**
 * `personas` テーブルへのアクセス（TASKS A-2-R-2）。
 *
 * **このモジュールだけが `personas` を触る**（MODULE_RULES 1）。
 *
 * **IDだけで引く関数を用意しない**（SPEC 14.1）。取得も更新も `userId` を伴う。
 * `user_personas` は `user_id` が unique だったので条件に入れるだけで足りたが、
 * **`personas` は1ユーザー複数件**なので、`id` と `userId` の両方で絞る。
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { can } from '@/lib/entitlements';
import { invalidPersonaError, personaNotFoundError } from './errors';
import {
  MAX_ACTIVE_PERSONAS,
  maxActivePersonas,
  normalizeCreatePersona,
  normalizeUpdatePersona,
  type AppPersona,
  type PersonaAudience,
  type PersonaBusiness,
  type PersonaExpertise,
  type PersonaIdentity,
  type PersonaStatus,
  type PersonaType,
} from './persona';

const SELECT = {
  id: true,
  userId: true,
  name: true,
  personaType: true,
  identity: true,
  expertise: true,
  audience: true,
  business: true,
  status: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface Row {
  id: string;
  userId: string;
  name: string;
  personaType: string;
  identity: Prisma.JsonValue;
  expertise: Prisma.JsonValue;
  audience: Prisma.JsonValue;
  business: Prisma.JsonValue;
  status: string;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toApp(row: Row): AppPersona {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    personaType: row.personaType as PersonaType,
    identity: row.identity as unknown as PersonaIdentity,
    expertise: row.expertise as unknown as PersonaExpertise,
    audience: row.audience as unknown as PersonaAudience,
    business: row.business as unknown as PersonaBusiness,
    status: row.status as PersonaStatus,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 分身を作る。
 *
 * **作った時点では `DRAFT`。** 作ることと使い始めることを分ける。
 * `ACTIVE` の数には上限があり（`activatePersonaForUser`）、
 * 下書きのまま置いておけるほうが、上限に当たっても作業が止まらない。
 */
export async function createPersonaForUser(
  userId: string,
  input: unknown,
): Promise<AppPersona> {
  if (!(await can(userId, 'persona.create'))) {
    throw invalidPersonaError('分身をこれ以上作れません');
  }

  const normalized = normalizeCreatePersona(input);

  const row = await prisma.persona.create({
    data: {
      userId,
      name: normalized.name,
      personaType: normalized.personaType,
      identity: normalized.identity as unknown as Prisma.InputJsonValue,
      expertise: normalized.expertise as unknown as Prisma.InputJsonValue,
      audience: normalized.audience as unknown as Prisma.InputJsonValue,
      business: normalized.business as unknown as Prisma.InputJsonValue,
    },
    select: SELECT,
  });

  return toApp(row);
}

/**
 * 自分の分身を並べる。
 *
 * **`ARCHIVED` も返す。** 途中でやめた分身があること自体が実験の結果で、
 * 一覧から消すと「最初から作らなかった」と区別できない（H-4 と同じ筋）。
 */
export async function listPersonasForUser(
  userId: string,
): Promise<AppPersona[]> {
  const rows = await prisma.persona.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: SELECT,
  });

  return rows.map(toApp);
}

/** 1件引く。**無ければ `null`**（未作成は異常ではない） */
export async function findPersonaForUser(params: {
  userId: string;
  personaId: string;
}): Promise<AppPersona | null> {
  const row = await prisma.persona.findFirst({
    // **`id` と `userId` の両方で絞る**（1ユーザー複数件になったため）
    where: { id: params.personaId, userId: params.userId },
    select: SELECT,
  });

  return row === null ? null : toApp(row);
}

/** 無ければ404。**他人のものも同じ見え方にする**（SPEC 14.1） */
export async function requirePersonaForUser(params: {
  userId: string;
  personaId: string;
}): Promise<AppPersona> {
  const found = await findPersonaForUser(params);

  if (found === null) {
    throw personaNotFoundError();
  }

  return found;
}

/** 部分更新。**渡さなかった項目は変えない** */
export async function updatePersonaForUser(
  params: { userId: string; personaId: string },
  input: unknown,
): Promise<AppPersona> {
  await requirePersonaForUser(params);

  const normalized = normalizeUpdatePersona(input);

  const row = await prisma.persona.update({
    where: { id: params.personaId },
    data: {
      ...(normalized.name === undefined ? {} : { name: normalized.name }),
      ...(normalized.personaType === undefined
        ? {}
        : { personaType: normalized.personaType }),
      ...(normalized.identity === undefined
        ? {}
        : {
            identity: normalized.identity as unknown as Prisma.InputJsonValue,
          }),
      ...(normalized.expertise === undefined
        ? {}
        : {
            expertise: normalized.expertise as unknown as Prisma.InputJsonValue,
          }),
      ...(normalized.audience === undefined
        ? {}
        : {
            audience: normalized.audience as unknown as Prisma.InputJsonValue,
          }),
      ...(normalized.business === undefined
        ? {}
        : {
            business: normalized.business as unknown as Prisma.InputJsonValue,
          }),
    },
    select: SELECT,
  });

  return toApp(row);
}

/** いま `ACTIVE` な分身の数 */
export async function countActivePersonasForUser(
  userId: string,
): Promise<number> {
  return prisma.persona.count({ where: { userId, status: 'ACTIVE' } });
}

/**
 * 参加してから何日経ったか（ROADMAP 5章、Q-034）。
 *
 * **起点は `users.activated_at`。** ADMINが参加を認めた時刻で、
 * 登録時刻（`created_at`）ではない。承認待ちの期間まで日数に含めると、
 * **使い始める前に2体目が開く。**
 *
 * まだ認められていなければ `null`。
 */
async function elapsedDaysSinceJoin(
  userId: string,
  now: Date,
): Promise<number | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activatedAt: true },
  });

  if (user?.activatedAt == null) {
    return null;
  }

  return Math.floor(
    (now.getTime() - user.activatedAt.getTime()) / (24 * 60 * 60_000),
  );
}

/**
 * 分身を使い始める。
 *
 * **上限は2つある。**
 *
 * 1. 全体の上限（3体）
 * 2. **経過日数による段階解放**（ROADMAP 5章）。1〜30日は1体、
 *    31〜60日は2体、61〜90日は3体
 *
 * **習熟に合わせて開ける。** 最初から3体を渡すと、承認が溜まって止まる。
 *
 * 数えてから入れるので、同時に2回来ると上限を1つ超えうる。Phase 0 は
 * 1人が自分の画面から操作するだけなので、アプリ層の判定で足りる
 * （**超えたことが致命傷にならない** — 使わない分身は `PAUSED` へ戻せる）。
 *
 * **`activated_at` は最初の1回だけ入れる。** 止めて再開するたびに
 * 更新すると、日数の数え方が変わってしまう。
 */
export async function activatePersonaForUser(params: {
  userId: string;
  personaId: string;
  now?: Date;
}): Promise<AppPersona> {
  const persona = await requirePersonaForUser(params);

  if (persona.status === 'ACTIVE') {
    // **同じ状態への操作は成功させる。** 二度押しでエラーにしない（F-6 と同じ）
    return persona;
  }

  const now = params.now ?? new Date();
  const active = await countActivePersonasForUser(params.userId);

  if (active >= MAX_ACTIVE_PERSONAS) {
    throw invalidPersonaError(
      `同時に使える分身は${MAX_ACTIVE_PERSONAS}体までです`,
    );
  }

  const elapsedDays = await elapsedDaysSinceJoin(params.userId, now);

  // **まだ参加を認められていなければ、段階解放は効かせない。**
  // ここで断ると「作れるのに使い始められない」状態になり、
  // 原因が画面から読めない。参加前にアプリを使えないことは
  // `isActiveUser`（H-1）が別に担保している
  if (elapsedDays !== null) {
    const allowed = maxActivePersonas(elapsedDays);

    if (active >= allowed) {
      throw invalidPersonaError(
        `いまは分身を${allowed}体まで使えます（参加から${elapsedDays}日）`,
      );
    }
  }

  const row = await prisma.persona.update({
    where: { id: params.personaId },
    data: {
      status: 'ACTIVE',
      ...(persona.activatedAt === null ? { activatedAt: now } : {}),
    },
    select: SELECT,
  });

  return toApp(row);
}

/**
 * 分身を止める。
 *
 * **`ARCHIVED` にはしない。** 止めるのと畳むのは別の操作で、
 * 同じ入口にすると取り違える（H-1 で停止と退会を分けたのと同じ）。
 */
export async function pausePersonaForUser(params: {
  userId: string;
  personaId: string;
}): Promise<AppPersona> {
  await requirePersonaForUser(params);

  const row = await prisma.persona.update({
    where: { id: params.personaId },
    data: { status: 'PAUSED' },
    select: SELECT,
  });

  return toApp(row);
}
