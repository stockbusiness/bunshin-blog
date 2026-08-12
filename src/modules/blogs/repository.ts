import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import {
  DEFAULT_ARTICLE_RATIO,
  parseArticleRatio,
  withWeeklyPublishCap,
} from './article-ratio';
import { ownedBy, requireFound } from './ownership';
import {
  assignPublishSchedule,
  fromPublishTimeColumn,
  toPublishTimeColumn,
  type PermalinkPattern,
} from './publish-schedule';
import {
  MAX_BLOGS_PER_USER,
  availableSlots,
  isBlogSlotNumber,
  resolveSlotNumber,
  slotTakenError,
  type BlogSlotNumber,
  type BlogSlotOccupancy,
  type BlogSlotUsage,
} from './slots';
import type { AppBlog, CreateBlogInput, UpdateBlogInput } from './types';

/**
 * `blogs` テーブルへのアクセス（B-3）。
 *
 * **このモジュールだけが `blogs` テーブルを触る**（MODULE_RULES 1）。
 * **全ての取得・更新・削除は `userId` で絞り込む**（SPEC 14.1）。
 */

interface BlogRecord {
  id: string;
  userId: string;
  personaId: string;
  name: string;
  slug: string;
  targetReader: string;
  penName: string | null;
  purpose: string;
  status: string;
  slotNumber: number;
  launchDate: Date | null;
  createdAt: Date;
  linkEventTokenIssuedAt: Date | null;
  publishWeekdays: number[];
  publishTime: Date;
  publishJitterMin: number;
  permalinkPattern: string;
  initialArticleCount: number;
  articleRatio: unknown;
  genre: { id: string; name: string; category: string } | null;
}

/**
 * ジャンルを一緒に引く（B-5）。
 *
 * `genres` は `blogs` モジュールの所有テーブル（MODULE_RULES）。
 * 設定画面では表示のみで、変更は E-4 の審査を経由する（Q-009）。
 */
const WITH_GENRE = {
  genre: { select: { id: true, name: true, category: true } },
} as const;

function toAppBlog(record: BlogRecord): AppBlog {
  return {
    id: record.id,
    userId: record.userId,
    personaId: record.personaId,
    name: record.name,
    slug: record.slug,
    targetReader: record.targetReader,
    penName: record.penName,
    purpose: record.purpose as AppBlog['purpose'],
    status: record.status as AppBlog['status'],
    slotNumber: record.slotNumber,
    launchDate: record.launchDate,
    createdAt: record.createdAt,
    articleRatio: parseArticleRatio(record.articleRatio),
    genre: record.genre,
    linkEventTokenIssuedAt: record.linkEventTokenIssuedAt,
    publishWeekdays: record.publishWeekdays,
    publishTime: fromPublishTimeColumn(record.publishTime),
    publishJitterMin: record.publishJitterMin,
    permalinkPattern: record.permalinkPattern as PermalinkPattern,
    initialArticleCount: record.initialArticleCount,
  };
}

/** 一覧の並び。slot 順に固定し、画面ごとに変わらないようにする */
const LIST_ORDER = { slotNumber: 'asc' } as const;

/**
 * 自分のブログ一覧。
 *
 * `CLOSED` は既定で含めない。退会・削除済みが一覧に出続けないため
 * （SPEC 13.2「削除は物理削除せずCLOSED」）。
 */
export async function listBlogsForUser(
  userId: string,
  options: { includeClosed?: boolean } = {},
): Promise<AppBlog[]> {
  const records = await prisma.blog.findMany({
    where: {
      userId,
      ...(options.includeClosed === true ? {} : { status: { not: 'CLOSED' } }),
    },
    include: WITH_GENRE,
    orderBy: LIST_ORDER,
  });

  return records.map(toAppBlog);
}

/**
 * 自分のブログを1件引く。他人のものは `null`。
 *
 * **IDだけで引く関数は用意しない**（SPEC 14.1 の禁止事項）。
 */
export async function findBlogForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppBlog | null> {
  const record = await prisma.blog.findFirst({
    where: ownedBy({ userId: params.userId, id: params.blogId }),
    include: WITH_GENRE,
  });

  return record === null ? null : toAppBlog(record);
}

/**
 * 自分のブログを1件引く。無ければ404。
 *
 * **他モジュールがブログ配下の資源を扱う前に、これを通す。**
 * 例：`wordpress` が接続情報を保存する前に、そのブログが自分のものか確かめる。
 */
export async function requireBlogForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppBlog> {
  return requireFound(await findBlogForUser(params));
}

/**
 * スロットの使用状況（B-4）。
 *
 * **`CLOSED` を含める。** 閉じたブログもスロットを保持し続ける（Q-008）。
 * 一覧（`listBlogsForUser`）が既定で `CLOSED` を外すのとは方針が異なる。
 */
export async function getSlotUsageForUser(
  userId: string,
): Promise<BlogSlotUsage> {
  const records = await prisma.blog.findMany({
    where: { userId },
    select: { id: true, slotNumber: true, status: true },
    orderBy: LIST_ORDER,
  });

  const used: BlogSlotOccupancy[] = records
    // CHECK 制約で 1〜3 に限られるが、範囲外の行があっても空き計算を壊さない
    .filter((record) => isBlogSlotNumber(record.slotNumber))
    .map((record) => ({
      slotNumber: record.slotNumber as BlogSlotNumber,
      blogId: record.id,
      status: record.status as AppBlog['status'],
    }));

  const available = availableSlots(used);

  return {
    limit: MAX_BLOGS_PER_USER,
    used,
    available,
    remaining: available.length,
  };
}

/** Prisma の制約違反を、意味のあるエラーへ変換する */
function toConflictError(
  error: unknown,
  slotNumber: BlogSlotNumber,
): AppError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002: unique 制約（UNIQUE(user_id, slot_number)）。
    // アプリ側の判定を通った後にここへ来るのは、同時に2件作られた場合
    if (error.code === 'P2002') {
      return slotTakenError({ slotNumber, closed: false });
    }
    // P2003: 外部キー違反。`(persona_id, user_id)` の複合外部キー
    // （A-2-R-2c-schema）に当たる場合が本命で、**他人の分身IDか、
    // 存在しないID**のどちらか。
    //
    // **どちらかを文言で区別しない**（SPEC 14.1）。区別すると
    // 「そのIDの分身は存在する」ことを他人に教えることになる
    if (error.code === 'P2003') {
      return AppError.validationFailed('指定された分身が見つかりません');
    }
    // P2010 / P2000 系: CHECK 制約（blogs_slot_range）など
    if (error.code === 'P2010' || error.code === 'P2000') {
      return AppError.validationFailed('ブログの内容を確認してください');
    }
  }

  // CHECK 制約違反は raw なDBエラーとして上がることがある
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('blogs_slot_range')
  ) {
    return AppError.validationFailed('スロット番号は1〜3で指定してください');
  }

  return null;
}

/**
 * ブログを作る。
 *
 * `userId` はセッションから渡すこと。**入力に `userId` を含めない。**
 *
 * 上限3件・スロット重複・`CLOSED` の再利用は `resolveSlotNumber` が判定する
 * （B-4）。`UNIQUE(user_id, slot_number)` と
 * `CHECK(slot_number BETWEEN 1 AND 3)` は同時実行に対する最後の砦として残す。
 *
 * `input.slotNumber` を省略すると空いている最小の番号を割り当てる。
 *
 * **`personaId` の持ち主はここでは確かめない。** 依存の向きが
 * `personas → blogs`（MODULE_RULES）で、`personas` を import すると循環する。
 * 他人の分身IDは **DBの複合外部キー**が拒む（A-2-R-2c-schema）。
 * 分身が使える状態か（`ACTIVE` か）の判定は呼び出し側（`src/app/`）が行う
 * — こちらは実験の運用方針であって、越境の防止ではない。
 */
export async function createBlogForUser(
  userId: string,
  input: CreateBlogInput,
): Promise<AppBlog> {
  const usage = await getSlotUsageForUser(userId);
  const slotNumber = resolveSlotNumber({
    used: usage.used,
    requested: input.slotNumber,
  });

  // **1分身につきブログ1件**（DATA_MODEL 2章「アプリ層の制約」）。
  //
  // `CLOSED` も数える。閉じたブログがスロットを保持し続ける（Q-008）のと
  // 同じ扱いにする — **閉じれば作り直せる**にすると、分身を替えずに
  // media を作り直せてしまい、実験の一次データが繋がらなくなる
  if (
    (await prisma.blog.count({
      where: { userId, personaId: input.personaId },
    })) > 0
  ) {
    throw AppError.validationFailed('この分身のブログはすでにあります');
  }

  // **ブログごとに散らして割り当てる**（C-9・W-8）。
  //
  // 種は `(userId, slotNumber)` — **IDはDBが採番するので、作る前には
  // 分からない**。この2つの組はブログを一意に決める（`UNIQUE`）
  const schedule = assignPublishSchedule(`${userId}:${String(slotNumber)}`);

  try {
    const record = await prisma.blog.create({
      data: {
        userId,
        personaId: input.personaId,
        publishWeekdays: schedule.publishWeekdays,
        publishTime: toPublishTimeColumn(schedule.publishTime),
        publishJitterMin: schedule.publishJitterMin,
        permalinkPattern: schedule.permalinkPattern,
        initialArticleCount: schedule.initialArticleCount,
        name: input.name,
        slug: input.slug,
        targetReader: input.targetReader,
        slotNumber,
        penName: input.penName ?? null,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        // 記事構成の既定値。SPEC 9.3 の初期30記事・週4本
        articleRatio: { ...DEFAULT_ARTICLE_RATIO },
      },
      include: WITH_GENRE,
    });

    return toAppBlog(record);
  } catch (error) {
    const mapped = toConflictError(error, slotNumber);
    if (mapped !== null) {
      throw mapped;
    }
    throw error;
  }
}

/**
 * 自分のブログを更新する。他人のものは404。
 *
 * `updateMany` を所有権付きで使う。`update` は主キーのみで対象を決めるため、
 * 所有権を条件に含められない。
 *
 * `weeklyPublishCap` を指定した場合、**`article_ratio` の他の項目は
 * 現在の値を引き継ぐ**（B-5・Q-011）。上限だけを受け取って全体を
 * 組み立て直すと、SPEC 9.2.4 の算出値が既定値で上書きされる。
 */
export async function updateBlogForUser(
  params: { userId: string; blogId: string },
  input: UpdateBlogInput,
): Promise<AppBlog> {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data['name'] = input.name;
  if (input.slug !== undefined) data['slug'] = input.slug;
  if (input.targetReader !== undefined)
    data['targetReader'] = input.targetReader;
  if (input.penName !== undefined) data['penName'] = input.penName;
  if (input.purpose !== undefined) data['purpose'] = input.purpose;
  if (input.status !== undefined) data['status'] = input.status;

  if (input.weeklyPublishCap !== undefined) {
    // 現在値が要るため先に引く。所有していなければここで404になり、
    // 不正な上限を投げる前に止まる
    const current = await requireBlogForUser(params);
    data['articleRatio'] = {
      ...withWeeklyPublishCap(current.articleRatio, input.weeklyPublishCap),
    };
  }

  if (Object.keys(data).length === 0) {
    return requireBlogForUser(params);
  }

  const result = await prisma.blog.updateMany({
    where: ownedBy({ userId: params.userId, id: params.blogId }),
    data,
  });

  // 0件なら「存在しない」か「他人のもの」。どちらも404に揃える
  requireFound(result.count === 0 ? null : result.count);

  return requireBlogForUser(params);
}

/**
 * ブログを閉じる。
 *
 * **物理削除しない**（SPEC 13.2）。`CLOSED` にする。
 */
export async function closeBlogForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppBlog> {
  const result = await prisma.blog.updateMany({
    where: ownedBy({ userId: params.userId, id: params.blogId }),
    data: { status: 'CLOSED' },
  });

  requireFound(result.count === 0 ? null : result.count);

  return requireBlogForUser({ ...params });
}
