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
import { requirePersonaForUser } from './persona-repository';
import type { EffectivePersona } from './persona';
import {
  normalizeCreatePersonaFact,
  normalizeUpdatePersonaFact,
} from './facts';
import type {
  AppBlogPersonaSetting,
  AppPersonaFact,
  CreatePersonaFactInput,
  FactSource,
  FactType,
  FactVerification,
  UpdatePersonaFactInput,
  AppUserPersona,
  BaseProfile,
  CreateUserPersonaInput,
  PersonaValues,
  SaveBlogPersonaSettingInput,
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
 * **媒体別の上書きだけを持つ**（A-2-R-2d・A-2-R-2e）。読者像は
 * `personas.audience`、使ってよい体験は分身の `persona_facts` が全部。
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
    // **もう読まない列**（A-2-R-2d）。読者像は `Persona.audience` が持つ。
    // まだ NOT NULL なので空で埋める。列の削除は A-2-R-3
    targetReader: {},
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
 * **どの分身で書くかはブログが持つ**（`blogs.persona_id`・A-2-R-2c）。
 * 利用者に1つしか人格が無かった頃（`user_personas`）は引数に要らなかったが、
 * **1ユーザーが複数の分身を持つようになったので、媒体から辿る。**
 *
 * ブログ別設定は無くてもよい（設定前のブログでも記事は書けるべき）。
 *
 * @throws {AppError} 他人のブログ（404）、分身の割り当てが無いブログ（404）
 */
export async function resolveEffectivePersonaForUser(params: {
  userId: string;
  blogId: string;
}): Promise<EffectivePersona> {
  const blog = await requireBlogForUser(params);

  // **A-2-R-2c より前に作られたブログだけがここへ来る。**
  // `blogs.persona_id` は A-2-R-3 で NOT NULL になり、この分岐は消える。
  // **推測で既定の分身を当てない** — 誰が書いた記事なのかが分からなくなる
  if (blog.personaId === null) {
    throw personaNotFoundError();
  }

  const [persona, setting] = await Promise.all([
    requirePersonaForUser({ userId: params.userId, personaId: blog.personaId }),
    findBlogPersonaSettingForUser(params),
  ]);

  return resolveEffectivePersona(persona, setting);
}

/**
 * `persona_facts` テーブルへのアクセス（TASKS D-6、SPEC 5.7）。
 *
 * **`user_id` で絞る。** 事実は人に紐づく（ブログではない）。ブログ固有の
 * 事実は `blog_id` を持つが、所有者は常に `user_id`。
 */

interface FactRow {
  id: string;
  userId: string;
  blogId: string | null;
  factType: string;
  content: string;
  source: string;
  verification: string;
  usableFirstPerson: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FACT_SELECT = {
  id: true,
  userId: true,
  blogId: true,
  factType: true,
  content: true,
  source: true,
  verification: true,
  usableFirstPerson: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toAppFact(row: FactRow): AppPersonaFact {
  return {
    id: row.id,
    userId: row.userId,
    blogId: row.blogId,
    factType: row.factType as FactType,
    content: row.content,
    source: row.source as FactSource,
    verification: row.verification as FactVerification,
    usableFirstPerson: row.usableFirstPerson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 事実を一覧する。
 *
 * `blogId` を渡すと、**そのブログ固有の事実と全ブログ共通の事実**を返す。
 * 記事生成（E-8）が使う形。
 */
export async function listPersonaFactsForUser(
  userId: string,
  options: {
    blogId?: string | undefined;
    usableFirstPersonOnly?: boolean | undefined;
  } = {},
): Promise<AppPersonaFact[]> {
  const rows = await prisma.personaFact.findMany({
    where: {
      userId,
      ...(options.blogId === undefined
        ? {}
        : { OR: [{ blogId: options.blogId }, { blogId: null }] }),
      ...(options.usableFirstPersonOnly === true
        ? { usableFirstPerson: true }
        : {}),
    },
    // `created_at` はミリ秒までしか持たない。同じミリ秒に作られると
    // 前後が決まらないので、`id` を最後の決め手にして並びを固定する
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: FACT_SELECT,
  });

  return rows.map(toAppFact);
}

/** 事実を1件引く。他人のものは `null` */
export async function findPersonaFactForUser(params: {
  userId: string;
  factId: string;
}): Promise<AppPersonaFact | null> {
  const row = await prisma.personaFact.findFirst({
    where: { id: params.factId, userId: params.userId },
    select: FACT_SELECT,
  });

  return row === null ? null : toAppFact(row);
}

/** 事実を1件引く。無ければ404（他人のものも404） */
export async function requirePersonaFactForUser(params: {
  userId: string;
  factId: string;
}): Promise<AppPersonaFact> {
  const fact = await findPersonaFactForUser(params);

  if (fact === null) {
    throw notFoundError('事実');
  }

  return fact;
}

/**
 * 事実を登録する。
 *
 * **`blogId` を渡す場合は所有権を確かめる。** 他人のブログに紐づく事実を
 * 作られると、そのブログの記事生成へ混ざる。
 */
export async function createPersonaFactForUser(
  userId: string,
  input: CreatePersonaFactInput,
): Promise<AppPersonaFact> {
  const data = normalizeCreatePersonaFact(input);

  const blogId =
    input.blogId === undefined
      ? null
      : await requireOpenBlogId({ userId, blogId: input.blogId });

  const row = await prisma.personaFact.create({
    data: { userId, blogId, ...data },
    select: FACT_SELECT,
  });

  return toAppFact(row);
}

/**
 * 事実を編集する（完了条件の中心）。
 *
 * **`source` と `verification` を現在の値と重ねてから判定する。**
 * 片方だけ更新したときに、禁じられる組み合わせを見落とさないため。
 */
export async function updatePersonaFactForUser(
  params: { userId: string; factId: string },
  input: UpdatePersonaFactInput,
): Promise<AppPersonaFact> {
  const current = await requirePersonaFactForUser(params);
  const data = normalizeUpdatePersonaFact(input, current);

  if (Object.keys(data).length === 0) {
    return current;
  }

  const result = await prisma.personaFact.updateMany({
    where: { id: params.factId, userId: params.userId },
    data,
  });

  if (result.count === 0) {
    throw notFoundError('事実');
  }

  return requirePersonaFactForUser(params);
}

/**
 * 事実を消す。
 *
 * **物理削除する。** 本人の経験の記録で、間違って入れたものを残す理由が
 * 無い（投稿や案件と違い、外部に痕跡が残らない）。
 *
 * **参照を掃除する相手がもう無い**（A-2-R-2e）。D-6 では
 * `blog_persona_settings.allowed_experiences` から外していたが、
 * その列を使うのをやめた。
 */
export async function deletePersonaFactForUser(params: {
  userId: string;
  factId: string;
}): Promise<void> {
  await requirePersonaFactForUser(params);

  await prisma.personaFact.deleteMany({
    where: { id: params.factId, userId: params.userId },
  });
}
