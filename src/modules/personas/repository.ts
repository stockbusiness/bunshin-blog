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
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import {
  normalizeSaveBlogPersonaSetting,
  normalizeUpdateBlogPersonaSetting,
  resolveEffectivePersona,
} from './blog-settings';
import { personaNotFoundError } from './errors';
import type {
  AppBlogPersonaSetting,
  AppUserPersona,
  BaseProfile,
  CreateUserPersonaInput,
  EffectivePersona,
  PersonaValues,
  SaveBlogPersonaSettingInput,
  TargetReader,
  Tone,
  ToneOverride,
  UpdateBlogPersonaSettingInput,
  UpdateUserPersonaInput,
  WritingRules,
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

/**
 * `blog_persona_settings` テーブルへのアクセス（TASKS D-5、SPEC 5.6）。
 *
 * **所有権は `blogs` モジュールの公開関数で確かめる**（SPEC 14.1）。
 * `blog_id` は unique なので、ブログの所有権を確かめれば越境の余地が無い。
 */

interface BlogSettingRow {
  id: string;
  blogId: string;
  penName: string;
  toneOverride: unknown;
  targetReader: unknown;
  allowedExperiences: string[];
  ngTopics: string[];
  writingRules: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const BLOG_SETTING_SELECT = {
  id: true,
  blogId: true,
  penName: true,
  toneOverride: true,
  targetReader: true,
  allowedExperiences: true,
  ngTopics: true,
  writingRules: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toAppBlogSetting(row: BlogSettingRow): AppBlogPersonaSetting {
  return {
    id: row.id,
    blogId: row.blogId,
    penName: row.penName,
    toneOverride: row.toneOverride as ToneOverride,
    targetReader: row.targetReader as TargetReader,
    allowedExperiences: row.allowedExperiences,
    ngTopics: row.ngTopics,
    writingRules: row.writingRules as WritingRules,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 所有権を確かめ、対象のブログIDを返す。`CLOSED` には設定させない */
async function requireOpenBlogId(params: {
  userId: string;
  blogId: string;
}): Promise<string> {
  const blog = await requireBlogForUser(params);

  if (blog.status === 'CLOSED') {
    throw notFoundError();
  }

  return blog.id;
}

/** ブログ別設定を引く。未設定なら `null` */
export async function findBlogPersonaSettingForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppBlogPersonaSetting | null> {
  const blogId = await requireOpenBlogId(params);

  const row = await prisma.blogPersonaSetting.findUnique({
    where: { blogId },
    select: BLOG_SETTING_SELECT,
  });

  return row === null ? null : toAppBlogSetting(row);
}

/**
 * ブログ別設定を保存する（完了条件「ブログ別の上書き設定が保存される」）。
 *
 * **`allowed_experiences` は受け取らない。** 参照先の `persona_facts` は
 * D-6 で作る。所有権を確かめられないIDを受け取ると、他人の体験を
 * 引き当てられる（C-6 で見つけたのと同じ形）。**入口は D-6 で足す。**
 */
export async function saveBlogPersonaSettingForUser(
  params: { userId: string; blogId: string },
  input: SaveBlogPersonaSettingInput,
): Promise<AppBlogPersonaSetting> {
  const blogId = await requireOpenBlogId(params);
  const data = normalizeSaveBlogPersonaSetting(input);

  const write = {
    penName: data.penName,
    toneOverride: data.toneOverride as unknown as Prisma.InputJsonObject,
    targetReader: data.targetReader as unknown as Prisma.InputJsonObject,
    ngTopics: data.ngTopics,
    writingRules: data.writingRules as unknown as Prisma.InputJsonObject,
  };

  const row = await prisma.blogPersonaSetting.upsert({
    where: { blogId },
    create: { blogId, ...write },
    update: write,
    select: BLOG_SETTING_SELECT,
  });

  return toAppBlogSetting(row);
}

/** ブログ別設定を部分的に編集する。未設定なら404 */
export async function updateBlogPersonaSettingForUser(
  params: { userId: string; blogId: string },
  input: UpdateBlogPersonaSettingInput,
): Promise<AppBlogPersonaSetting> {
  const current = await findBlogPersonaSettingForUser(params);

  if (current === null) {
    throw personaNotFoundError();
  }

  const data = normalizeUpdateBlogPersonaSetting(input);

  if (Object.keys(data).length === 0) {
    return current;
  }

  const row = await prisma.blogPersonaSetting.update({
    where: { blogId: current.blogId },
    data: {
      ...(data.penName === undefined ? {} : { penName: data.penName }),
      ...(data.toneOverride === undefined
        ? {}
        : {
            toneOverride:
              data.toneOverride as unknown as Prisma.InputJsonObject,
          }),
      ...(data.targetReader === undefined
        ? {}
        : {
            targetReader:
              data.targetReader as unknown as Prisma.InputJsonObject,
          }),
      ...(data.ngTopics === undefined ? {} : { ngTopics: data.ngTopics }),
      ...(data.writingRules === undefined
        ? {}
        : {
            writingRules:
              data.writingRules as unknown as Prisma.InputJsonObject,
          }),
    },
    select: BLOG_SETTING_SELECT,
  });

  return toAppBlogSetting(row);
}

/**
 * 記事生成が使う人格を組み立てる（E-8 の入力）。
 *
 * **共通人格が未登録なら404。** ブログ別設定は無くてもよい
 * （設定前のブログでも記事は書けるべき）。
 */
export async function resolveEffectivePersonaForUser(params: {
  userId: string;
  blogId: string;
}): Promise<EffectivePersona> {
  const persona = await requireUserPersonaForUser(params.userId);
  const setting = await findBlogPersonaSettingForUser(params);

  return resolveEffectivePersona(persona, setting);
}
