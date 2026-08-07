import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { BLOG_ERROR_CODES, ownedBy, requireFound } from './ownership';
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
  name: string;
  slug: string;
  targetReader: string;
  penName: string | null;
  purpose: string;
  status: string;
  slotNumber: number;
  launchDate: Date | null;
  createdAt: Date;
}

function toAppBlog(record: BlogRecord): AppBlog {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    slug: record.slug,
    targetReader: record.targetReader,
    penName: record.penName,
    purpose: record.purpose as AppBlog['purpose'],
    status: record.status as AppBlog['status'],
    slotNumber: record.slotNumber,
    launchDate: record.launchDate,
    createdAt: record.createdAt,
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

/** Prisma の制約違反を、意味のあるエラーへ変換する */
function toConflictError(error: unknown): AppError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002: unique 制約（UNIQUE(user_id, slot_number)）
    if (error.code === 'P2002') {
      return new AppError(
        BLOG_ERROR_CODES.conflict,
        409,
        'そのスロットは既に使われています',
      );
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
 * 3件上限の判定は B-4 で追加する。現時点では
 * `UNIQUE(user_id, slot_number)` と `CHECK(slot_number BETWEEN 1 AND 3)` により
 * 構造的に4件目が入らない（DATA_MODEL 4章）。
 */
export async function createBlogForUser(
  userId: string,
  input: CreateBlogInput,
): Promise<AppBlog> {
  try {
    const record = await prisma.blog.create({
      data: {
        userId,
        name: input.name,
        slug: input.slug,
        targetReader: input.targetReader,
        slotNumber: input.slotNumber,
        penName: input.penName ?? null,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        // 記事構成の既定値。SPEC 9.3 の初期30記事・週4本
        articleRatio: { revenue: 7, traffic: 23, weeklyPublishCap: 4 },
      },
    });

    return toAppBlog(record);
  } catch (error) {
    const mapped = toConflictError(error);
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
