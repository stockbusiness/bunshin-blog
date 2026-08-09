/**
 * `content_plans` と `content_items` へのアクセス（TASKS E-6）。
 *
 * **このモジュールだけがこの2テーブルを触る**（MODULE_RULES 1）。
 *
 * ## 実行のたびに新しい版を作る
 *
 * `content_plans` は `(blog_id, plan_type, version)` で一意。**同じ版を
 * 書き換えず、番号を増やして作る。** 書き換えると、既に投稿された記事が
 * どの構成表から生まれたのかが分からなくなる（`prompt_versions` を
 * 上書きしないのと同じ理由。E-2）。
 *
 * ## 記事はまとめて1つのトランザクションで入れる
 *
 * 途中で失敗すると、**半端な構成表**（収益記事が3本だけ入った状態）が
 * 残る。次に走らせたときに重複を数えるのが難しくなる。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireBlogForUser } from '@/modules/blogs';

export type ContentType =
  'INFORMATIONAL' | 'EXPERIENCE' | 'FAQ' | 'COMPARISON' | 'AFFILIATE';

export type Objective = 'TRAFFIC' | 'TRUST' | 'REVENUE' | 'INTERNAL_LINK';

export interface NewContentItem {
  sequenceNo: number;
  contentType: ContentType;
  title: string;
  primaryKeyword: string | null;
  searchIntent: string;
  objective: Objective;
  affiliateOfferId: string | null;
  publishPriority: number;
}

export interface AppContentItem {
  id: string;
  contentPlanId: string;
  blogId: string;
  sequenceNo: number;
  contentType: ContentType;
  title: string;
  primaryKeyword: string | null;
  searchIntent: string;
  objective: Objective;
  affiliateOfferId: string | null;
  publishPriority: number;
  status: string;
}

const ITEM_SELECT = {
  id: true,
  contentPlanId: true,
  blogId: true,
  sequenceNo: true,
  contentType: true,
  title: true,
  primaryKeyword: true,
  searchIntent: true,
  objective: true,
  affiliateOfferId: true,
  publishPriority: true,
  status: true,
} as const;

function toAppItem(row: {
  id: string;
  contentPlanId: string;
  blogId: string;
  sequenceNo: number;
  contentType: string;
  title: string;
  primaryKeyword: string | null;
  searchIntent: string;
  objective: string;
  affiliateOfferId: string | null;
  publishPriority: number;
  status: string;
}): AppContentItem {
  return {
    ...row,
    contentType: row.contentType as ContentType,
    objective: row.objective as Objective,
  };
}

export interface CreatedPlan {
  planId: string;
  version: number;
  items: AppContentItem[];
}

/**
 * 構成表を作り、記事をまとめて入れる。
 *
 * **自分のブログであることを先に確かめる**（SPEC 14.1）。
 *
 * `affiliate_offer_id` は呼び出し側から渡ってくるが、**このブログの案件で
 * あることは呼び出し側が確かめている**（`scoreOffersForUser` が
 * `listOffersForUser` 経由で取った案件しか渡さない）。ここでは
 * 外部キーの制約に任せる。
 */
export async function createPlanWithItemsForUser(params: {
  userId: string;
  blogId: string;
  planType: 'INITIAL' | 'MONTHLY' | 'AD_HOC';
  strategySnapshot: Prisma.InputJsonValue;
  items: readonly NewContentItem[];
}): Promise<CreatedPlan> {
  const blog = await requireBlogForUser(params);

  return prisma.$transaction(async (tx) => {
    const latest = await tx.contentPlan.findFirst({
      where: { blogId: blog.id, planType: params.planType },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const version = (latest?.version ?? 0) + 1;

    const plan = await tx.contentPlan.create({
      data: {
        blogId: blog.id,
        planType: params.planType,
        version,
        strategySnapshot: params.strategySnapshot,
      },
      select: { id: true },
    });

    const items: AppContentItem[] = [];

    for (const item of params.items) {
      const row = await tx.contentItem.create({
        data: {
          contentPlanId: plan.id,
          blogId: blog.id,
          sequenceNo: item.sequenceNo,
          contentType: item.contentType,
          title: item.title,
          primaryKeyword: item.primaryKeyword,
          searchIntent: item.searchIntent,
          objective: item.objective,
          affiliateOfferId: item.affiliateOfferId,
          publishPriority: item.publishPriority,
          inboundLinkItemIds: [],
          outboundLinkItemIds: [],
        },
        select: ITEM_SELECT,
      });

      items.push(toAppItem(row));
    }

    return { planId: plan.id, version, items };
  });
}

/** ブログの構成表の記事を並び順に返す */
export async function listContentItemsForUser(params: {
  userId: string;
  blogId: string;
  contentPlanId?: string | undefined;
}): Promise<AppContentItem[]> {
  const blog = await requireBlogForUser(params);

  const rows = await prisma.contentItem.findMany({
    where: {
      blogId: blog.id,
      ...(params.contentPlanId === undefined
        ? {}
        : { contentPlanId: params.contentPlanId }),
    },
    orderBy: [{ contentPlanId: 'asc' }, { sequenceNo: 'asc' }],
    select: ITEM_SELECT,
  });

  return rows.map(toAppItem);
}

/**
 * いちばん新しい構成表を引く。
 *
 * **`content-planning` の外から `content_items` を引く経路をここに集める。**
 * D-8 で残した「`affiliate_links.content_item_id` が同じブログかを
 * 確かめられない」穴は、この関数を使って E-7 で塞ぐ。
 */
export async function findLatestPlanForUser(params: {
  userId: string;
  blogId: string;
  planType: 'INITIAL' | 'MONTHLY' | 'AD_HOC';
}): Promise<{ planId: string; version: number } | null> {
  const blog = await requireBlogForUser(params);

  const plan = await prisma.contentPlan.findFirst({
    where: { blogId: blog.id, planType: params.planType },
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  });

  return plan === null ? null : { planId: plan.id, version: plan.version };
}
