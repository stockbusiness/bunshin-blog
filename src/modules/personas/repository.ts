/**
 * `blog_persona_settings` と `persona_facts` へのアクセス
 * （TASKS D-5・D-6、SPEC 5.6・5.7）。
 *
 * **このモジュールだけがこれらのテーブルを触る**（MODULE_RULES 1）。
 *
 * **IDだけで引く関数を用意しない**（SPEC 14.1）。取得も更新も `userId` を伴う。
 *
 * 分身そのもの（`personas`）は `persona-repository.ts` が持つ。
 * 旧 `user_personas` の入口は A-2-R-2f で消した。
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
  SaveBlogPersonaSettingInput,
  ToneOverride,
  UpdateBlogPersonaSettingInput,
  WritingRules,
} from './types';

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
 * **分身の割り当てが無いブログは存在しない**（`blogs.persona_id` は
 * `NOT NULL`・A-2-R-3）。推測で既定の分身を当てる分岐は要らない。
 *
 * @throws {AppError} 他人のブログ（404）
 */
export async function resolveEffectivePersonaForUser(params: {
  userId: string;
  blogId: string;
}): Promise<EffectivePersona> {
  const blog = await requireBlogForUser(params);

  const [persona, setting] = await Promise.all([
    requirePersonaForUser({ userId: params.userId, personaId: blog.personaId }),
    findBlogPersonaSettingForUser(params),
  ]);

  return resolveEffectivePersona(persona, setting);
}

/**
 * `persona_facts` テーブルへのアクセス（TASKS D-6・A-2-R-4、SPEC 5.7）。
 *
 * **記憶は分身に溜まる。** 所有は `persona` を辿って確かめる
 * （`user_id` と `blog_id` は A-2-R-4-schema で落とした）。
 * **`persona.userId` を必ず条件に入れる** — 他人の分身の記憶を引かせない
 * （SPEC 14.1）。
 */

interface FactRow {
  id: string;
  personaId: string;
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
  personaId: true,
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
    personaId: row.personaId,
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
 * `blogId` を渡すと、**そのブログを書く分身の記憶**を返す。記事生成（E-8）が
 * 使う形。ブログと分身は1対1なので、媒体から辿れば書き手の記憶が決まる。
 *
 * A-2-R-4 より前は「そのブログ固有の事実 + 全ブログ共通の事実」だった。
 * **記憶が分身に溜まるようになり、その分身の媒体は1件なので、
 * 「共通」と「固有」を分ける意味が無くなった。**
 *
 * 所有は `persona` 経由で絞る。**`persona.userId` を必ず条件に入れる** —
 * 他人の分身の記憶を引かせない（SPEC 14.1）。
 */
export async function listPersonaFactsForUser(
  userId: string,
  options: {
    blogId?: string | undefined;
    usableFirstPersonOnly?: boolean | undefined;
  } = {},
): Promise<AppPersonaFact[]> {
  const personaId =
    options.blogId === undefined
      ? undefined
      : (await requireBlogForUser({ userId, blogId: options.blogId }))
          .personaId;

  const rows = await prisma.personaFact.findMany({
    where: {
      persona: { userId },
      ...(personaId === undefined ? {} : { personaId }),
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
    where: { id: params.factId, persona: { userId: params.userId } },
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
 * **`personaId` の所有権を確かめる。** 他人の分身に記憶を足されると、
 * その分身の記事生成へ混ざる（C-6 で見つけたのと同じ形）。
 */
export async function createPersonaFactForUser(
  userId: string,
  input: CreatePersonaFactInput,
): Promise<AppPersonaFact> {
  const data = normalizeCreatePersonaFact(input);
  const persona = await requirePersonaForUser({
    userId,
    personaId: input.personaId,
  });

  const row = await prisma.personaFact.create({
    data: { personaId: persona.id, ...data },
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
    where: { id: params.factId, persona: { userId: params.userId } },
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
    where: { id: params.factId, persona: { userId: params.userId } },
  });
}
