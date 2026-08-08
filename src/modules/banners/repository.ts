/**
 * `banners` テーブルへのアクセス（TASKS D-3、SPEC 5.9）。
 *
 * **このモジュールだけが `banners` を触る**（MODULE_RULES 1）。
 * **所有権は `blogs` モジュールの公開関数で確かめる**（SPEC 14.1）。
 *
 * ## 案件との紐付けは `affiliate` の公開関数を通す
 *
 * `affiliate_offer_id` を素通しすると、**他ブログの案件をバナーに
 * 紐づけられる**（`affiliate_offers.id` は全ブログで一意）。C-6 で
 * `wordpress_posts` に同じ穴が見つかっている。
 *
 * ここでは `affiliate` の `findOfferForUser` を通して確かめる。
 * **`affiliate_offers` を直接読まない**（MODULE_RULES 1）。C-6 のときと
 * 違い、所有モジュールが既にあるので実装側で確かめられる。
 *
 * 依存の向きは `banners` → `affiliate` の一方向。`affiliate` は
 * `banners` を import しない（MODULE_RULES 3）。
 */

import { prisma } from '@/lib/db';
import { findOfferForUser } from '@/modules/affiliate';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import type {
  AppBanner,
  BannerSlot,
  BannerStatus,
  CreateBannerInput,
  UpdateBannerInput,
} from './types';
import {
  assertBannerPeriod,
  normalizeCreateBanner,
  normalizeUpdateBanner,
} from './validate';

interface BannerRow {
  id: string;
  blogId: string;
  name: string;
  imageUrl: string;
  destinationUrl: string;
  affiliateOfferId: string | null;
  slot: string;
  targetCategories: string[];
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAppBanner(row: BannerRow): AppBanner {
  return {
    id: row.id,
    blogId: row.blogId,
    name: row.name,
    imageUrl: row.imageUrl,
    destinationUrl: row.destinationUrl,
    affiliateOfferId: row.affiliateOfferId,
    slot: row.slot as BannerSlot,
    targetCategories: row.targetCategories,
    status: row.status as BannerStatus,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SELECT = {
  id: true,
  blogId: true,
  name: true,
  imageUrl: true,
  destinationUrl: true,
  affiliateOfferId: true,
  slot: true,
  targetCategories: true,
  status: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** 所有権を確かめ、対象のブログIDを返す。`CLOSED` には足させない */
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

/**
 * 紐づける案件が同じブログのものか確かめる。
 *
 * **`affiliate` の公開関数を通す**（MODULE_RULES 1）。他ブログの案件なら
 * `null` が返るので、404 に揃える。
 */
async function requireOwnOfferId(
  params: { userId: string; blogId: string },
  offerId: string | null | undefined,
): Promise<string | null> {
  if (offerId === undefined || offerId === null) {
    return null;
  }

  const offer = await findOfferForUser({ ...params, offerId });

  if (offer === null) {
    throw notFoundError('案件');
  }

  return offer.id;
}

/** ブログのバナーを一覧する。**他ブログのものは出ない** */
export async function listBannersForUser(
  params: { userId: string; blogId: string },
  options: {
    status?: BannerStatus | undefined;
    slot?: BannerSlot | undefined;
  } = {},
): Promise<AppBanner[]> {
  const blogId = await requireOpenBlogId(params);

  const rows = await prisma.banner.findMany({
    where: {
      blogId,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.slot === undefined ? {} : { slot: options.slot }),
    },
    orderBy: [{ createdAt: 'asc' }],
    select: SELECT,
  });

  return rows.map(toAppBanner);
}

/**
 * バナーを1件引く。無ければ `null`。
 *
 * **`blog_id` を条件に入れる。** IDだけで引くと、他ブログのバナーが取れる
 * （`banners.id` は全ブログで一意）。
 */
export async function findBannerForUser(params: {
  userId: string;
  blogId: string;
  bannerId: string;
}): Promise<AppBanner | null> {
  const blogId = await requireOpenBlogId(params);

  const row = await prisma.banner.findFirst({
    where: { id: params.bannerId, blogId },
    select: SELECT,
  });

  return row === null ? null : toAppBanner(row);
}

/** バナーを1件引く。無ければ404（他ブログのものも404） */
export async function requireBannerForUser(params: {
  userId: string;
  blogId: string;
  bannerId: string;
}): Promise<AppBanner> {
  const banner = await findBannerForUser(params);

  if (banner === null) {
    throw notFoundError('バナー');
  }

  return banner;
}

/** バナーを登録する。完了条件の「表示位置・対象カテゴリ・有効期間」を保存する */
export async function createBannerForUser(
  params: { userId: string; blogId: string },
  input: CreateBannerInput,
): Promise<AppBanner> {
  const blogId = await requireOpenBlogId(params);
  const data = normalizeCreateBanner(input);
  const affiliateOfferId = await requireOwnOfferId(
    { userId: params.userId, blogId },
    input.affiliateOfferId,
  );

  const row = await prisma.banner.create({
    data: {
      blogId,
      name: data.name,
      imageUrl: data.imageUrl,
      destinationUrl: data.destinationUrl,
      affiliateOfferId,
      slot: data.slot,
      targetCategories: data.targetCategories,
      status: data.status,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
    },
    select: SELECT,
  });

  return toAppBanner(row);
}

/**
 * バナーを更新する。他ブログのものは404。
 *
 * **掲載期間は保存後の値どうしで確かめる。** 片方だけを更新したときに、
 * 既存のもう片方と逆転するのを防ぐ（D-1 と同じ）。
 */
export async function updateBannerForUser(
  params: { userId: string; blogId: string; bannerId: string },
  input: UpdateBannerInput,
): Promise<AppBanner> {
  const current = await requireBannerForUser(params);
  const data = normalizeUpdateBanner(input);

  if (input.affiliateOfferId !== undefined) {
    data['affiliateOfferId'] = await requireOwnOfferId(
      { userId: params.userId, blogId: current.blogId },
      input.affiliateOfferId,
    );
  }

  if (Object.keys(data).length === 0) {
    return current;
  }

  assertBannerPeriod(
    (data['startsAt'] as Date | null | undefined) ?? current.startsAt,
    (data['endsAt'] as Date | null | undefined) ?? current.endsAt,
  );

  const result = await prisma.banner.updateMany({
    where: { id: params.bannerId, blogId: current.blogId },
    data,
  });

  // 0件なら「存在しない」か「他ブログのもの」。どちらも404に揃える
  if (result.count === 0) {
    throw notFoundError('バナー');
  }

  return requireBannerForUser(params);
}

/**
 * バナーの掲載を終える。
 *
 * **物理削除しない**（SPEC 13.2 のブログと同じ扱い）。公開済み記事に
 * 埋まっており、クリックの集計も過去分を参照する。
 */
export async function endBannerForUser(params: {
  userId: string;
  blogId: string;
  bannerId: string;
}): Promise<AppBanner> {
  await requireBannerForUser(params);

  return updateBannerForUser(params, { status: 'ENDED' });
}
