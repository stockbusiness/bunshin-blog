/**
 * `user_personas` テーブルへのアクセス（TASKS D-4、SPEC 5.6）。
 *
 * **このモジュールだけが `user_personas` を触る**（MODULE_RULES 1）。
 *
 * **`user_id` で一意。** 1人につき1つの共通人格を持つ。ブログ別の上書きは
 * `blog_persona_settings`（D-5）が担う。
 *
 * **IDだけで引く関数を用意しない**（SPEC 14.1）。取得も更新も `userId` を伴う。
 * `user_id` が unique なので、条件に入れるだけで越境の余地が無くなる。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { personaNotFoundError } from './errors';
import type {
  AppUserPersona,
  BaseProfile,
  CreateUserPersonaInput,
  PersonaValues,
  Tone,
  UpdateUserPersonaInput,
} from './types';
import {
  normalizeCreateUserPersona,
  normalizeUpdateUserPersona,
} from './validate';

interface PersonaRow {
  id: string;
  userId: string;
  baseProfile: unknown;
  tone: unknown;
  values: unknown;
  ngExpressions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  userId: true,
  baseProfile: true,
  tone: true,
  values: true,
  ngExpressions: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 保存済みの行を外向けの表現へ写す。
 *
 * **保存時に検証済みなので、ここでは形を信じる。** ただしDBを直接
 * 書き換えられた場合に備え、型の主張だけに留めて例外は投げない
 * （読み出しで落ちると、直す画面にも入れなくなる）。
 */
function toAppPersona(row: PersonaRow): AppUserPersona {
  return {
    id: row.id,
    userId: row.userId,
    baseProfile: row.baseProfile as BaseProfile,
    tone: row.tone as Tone,
    values: row.values as PersonaValues,
    ngExpressions: row.ngExpressions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 自分の共通人格を引く。未登録なら `null` */
export async function findUserPersonaForUser(
  userId: string,
): Promise<AppUserPersona | null> {
  const row = await prisma.userPersona.findUnique({
    where: { userId },
    select: SELECT,
  });

  return row === null ? null : toAppPersona(row);
}

/** 自分の共通人格を引く。未登録なら404 */
export async function requireUserPersonaForUser(
  userId: string,
): Promise<AppUserPersona> {
  const persona = await findUserPersonaForUser(userId);

  if (persona === null) {
    throw personaNotFoundError();
  }

  return persona;
}

/**
 * 共通人格を作る、または丸ごと差し替える。
 *
 * **`upsert` を使う。** 「引いてから入れる」を分けると、同時に2回呼ばれた
 * ときに片方が unique 制約で落ちる（B-11・E-1 と同じ考え）。
 */
export async function saveUserPersonaForUser(
  userId: string,
  input: CreateUserPersonaInput,
): Promise<AppUserPersona> {
  const data = normalizeCreateUserPersona(input);

  const row = await prisma.userPersona.upsert({
    where: { userId },
    create: {
      userId,
      baseProfile: data.baseProfile as unknown as Prisma.InputJsonObject,
      tone: data.tone as unknown as Prisma.InputJsonObject,
      values: data.values as unknown as Prisma.InputJsonObject,
      ngExpressions: data.ngExpressions,
    },
    update: {
      baseProfile: data.baseProfile as unknown as Prisma.InputJsonObject,
      tone: data.tone as unknown as Prisma.InputJsonObject,
      values: data.values as unknown as Prisma.InputJsonObject,
      ngExpressions: data.ngExpressions,
    },
    select: SELECT,
  });

  return toAppPersona(row);
}

/**
 * 共通人格を部分的に編集する（完了条件「ユーザー共通人格を編集できる」）。
 *
 * **未登録なら404。** 作るのは `saveUserPersonaForUser` の担当で、
 * 一部だけ渡された入力から作ると残りが空のまま保存される。
 */
export async function updateUserPersonaForUser(
  userId: string,
  input: UpdateUserPersonaInput,
): Promise<AppUserPersona> {
  const current = await requireUserPersonaForUser(userId);
  const data = normalizeUpdateUserPersona(input);

  if (Object.keys(data).length === 0) {
    return current;
  }

  const row = await prisma.userPersona.update({
    where: { userId },
    data: {
      ...(data.baseProfile === undefined
        ? {}
        : {
            baseProfile: data.baseProfile as unknown as Prisma.InputJsonObject,
          }),
      ...(data.tone === undefined
        ? {}
        : { tone: data.tone as unknown as Prisma.InputJsonObject }),
      ...(data.values === undefined
        ? {}
        : { values: data.values as unknown as Prisma.InputJsonObject }),
      ...(data.ngExpressions === undefined
        ? {}
        : { ngExpressions: data.ngExpressions }),
    },
    select: SELECT,
  });

  return toAppPersona(row);
}
