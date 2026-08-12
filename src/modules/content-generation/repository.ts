/**
 * `prompt_versions` テーブルへのアクセス（TASKS E-2、SPEC 6.2）。
 *
 * **このモジュールだけが `prompt_versions` を触る**（MODULE_RULES 1）。
 *
 * ## 利用者に紐づかない
 *
 * プロンプトは**システム全体で1組**。ユーザーごとに持たない。所有権の
 * 判定に使える情報が無いので `...ForUser` の形にならない。
 *
 * 触れるのは ADMIN だけ（SPEC 6.2 `/admin/prompts`）。**横断参照であることが
 * 分かる名前にする**（MODULE_RULES 5 の `...ForAdmin` と同じ扱い）。
 * 呼び出し側で `requireAdmin` を通すこと。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordAudit } from '@/modules/audit';
import {
  duplicateVersionError,
  noActiveVersionError,
  promptNotFoundError,
} from './errors';
import {
  normalizeCreatePromptVersion,
  normalizePromptKey,
  normalizePromptVersion,
} from './prompt';
import type { AppPromptVersion, CreatePromptVersionInput } from './types';

const SELECT = {
  id: true,
  key: true,
  version: true,
  body: true,
  isActive: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * いま使う版を引く（記事生成が呼ぶ）。
 *
 * **`isActive` で引く。** 「いちばん新しい版」ではない。新しい版を
 * 作っただけで生成の挙動が変わってしまうと、試すことができない。
 */
export async function findActivePrompt(
  key: string,
): Promise<AppPromptVersion | null> {
  const row = await prisma.promptVersion.findFirst({
    where: { key: normalizePromptKey(key), isActive: true },
    select: SELECT,
  });

  return row;
}

/**
 * いま使う版を引く。無ければ落とす。
 *
 * **記事生成を止める。** 版が決まらないまま生成すると、何で作った記事か
 * 記録できない（`article_versions.prompt_version` が参照する）。
 */
export async function requireActivePrompt(
  key: string,
): Promise<AppPromptVersion> {
  const prompt = await findActivePrompt(key);

  if (prompt === null) {
    throw noActiveVersionError(key);
  }

  return prompt;
}

/** 種類ごとの版を新しい順に並べる（`/admin/prompts` の一覧） */
export async function listPromptVersionsForAdmin(
  key?: string,
): Promise<AppPromptVersion[]> {
  return prisma.promptVersion.findMany({
    where: key === undefined ? {} : { key: normalizePromptKey(key) },
    // **版の文字列で並べない。** `v10` が `v9` より前に来る
    //
    // `created_at` はミリ秒までしか持たない（Prisma が JS の `Date` を送る）。
    // **同じミリ秒に作られた版の前後は決められない。** せめて呼ぶたびに
    // 入れ替わらないよう `id` を最後の決め手にする — 作成の順を表さないが、
    // 一覧が見るたびに違う順で出るのは防げる。
    orderBy: [{ key: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: SELECT,
  });
}

/** 版を1件引く */
export async function findPromptVersionForAdmin(params: {
  key: string;
  version: string;
}): Promise<AppPromptVersion | null> {
  const row = await prisma.promptVersion.findUnique({
    where: {
      key_version: {
        key: normalizePromptKey(params.key),
        version: normalizePromptVersion(params.version),
      },
    },
    select: SELECT,
  });

  return row;
}

/**
 * 版を作る。
 *
 * **同じ版を上書きしない。** 版は「どのプロンプトで生成したか」を後から
 * 辿るための記録で、中身が変わると**過去の記事の生成条件が分からなくなる**。
 *
 * `activate: true` を渡すと、作ると同時に有効化する。
 *
 * @throws {AppError} 入力の不備・同じ版が既にある
 */
export async function createPromptVersionForAdmin(
  input: CreatePromptVersionInput,
): Promise<AppPromptVersion> {
  const data = normalizeCreatePromptVersion(input);

  let created: AppPromptVersion;
  try {
    created = await prisma.promptVersion.create({
      data: { ...data, isActive: false },
      select: SELECT,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw duplicateVersionError(data.key, data.version);
    }

    throw error;
  }

  // **版を作ったことを残す**（SPEC 14.4「AIプロンプト変更」、H-13）。
  //
  // **本文は入れない。** `prompt_versions` に残っており、
  // 監査ログに写すと同じものが2か所になる。残すのは鍵と版だけ。
  //
  // **行為者は残せない。** この関数は ADMIN の操作としてしか呼ばれないが、
  // 誰が呼んだかを引数に持たない（`...ForAdmin` は横断参照の印で、
  // 行為者を伴わない）。**ここで嘘の行為者を入れない**
  await recordAudit({
    actorUserId: null,
    action: 'PROMPT_VERSION_CREATED',
    entityType: 'prompt_version',
    entityId: created.id,
    metadata: { key: data.key, version: data.version },
  });

  if (input.activate !== true) {
    return created;
  }

  return activatePromptVersionForAdmin({
    key: data.key,
    version: data.version,
  });
}

/**
 * 版を有効にする（完了条件「有効化・ロールバックができる」）。
 *
 * **ロールバックも同じ関数。** 過去の版を指定して呼べば戻る。
 * 「1つ前へ戻す」専用の入口を作らない — どの版へ戻すかは
 * 一覧（`/admin/prompts`）を見て人が選ぶもので、履歴を別に持つ理由が無い。
 *
 * ## 1つの `key` に有効な版は1つまで
 *
 * **1文のUPDATEで入れ替える。**
 *
 * ```sql
 * update prompt_versions set is_active = (version = $2) where key = $1
 * ```
 *
 * 「他を無効にしてから有効にする」を2文に分けると、同時に別々の版を
 * 有効化したときに**2つ有効な状態**が残りうる。1文なら、その `key` の
 * 全行が常に整合した状態で書き変わる（後から実行したほうが丸ごと勝つ）。
 *
 * @throws {AppError} 指定した版が無い
 */
export async function activatePromptVersionForAdmin(params: {
  key: string;
  version: string;
}): Promise<AppPromptVersion> {
  const key = normalizePromptKey(params.key);
  const version = normalizePromptVersion(params.version);

  const target = await prisma.promptVersion.findUnique({
    where: { key_version: { key, version } },
    select: { id: true },
  });

  if (target === null) {
    throw promptNotFoundError();
  }

  await prisma.$executeRaw`
    update prompt_versions
       set is_active = (version = ${version}),
           updated_at = now()
     where key = ${key}
  `;

  const activated = await prisma.promptVersion.findUnique({
    where: { key_version: { key, version } },
    select: SELECT,
  });

  if (activated === null) {
    throw promptNotFoundError();
  }

  // **有効化も「プロンプト変更」**（SPEC 14.4、H-13）。
  // 版を作っただけでは生成は変わらない。**実際に効き始めたのはここ**
  await recordAudit({
    actorUserId: null,
    action: 'PROMPT_VERSION_ACTIVATED',
    entityType: 'prompt_version',
    entityId: activated.id,
    metadata: { key, version },
  });

  return activated;
}

/**
 * その種類の版を全て無効にする。
 *
 * **記事生成は止まる**（`requireActivePrompt` が落ちる）。使い道は
 * 「壊れた版を出してしまったが、戻す先も無い」場面に限る。
 */
export async function deactivatePromptForAdmin(key: string): Promise<number> {
  const result = await prisma.promptVersion.updateMany({
    where: { key: normalizePromptKey(key), isActive: true },
    data: { isActive: false },
  });

  return result.count;
}
