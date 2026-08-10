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
import { planNotFoundError } from './errors';

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

/**
 * 既にある構成表へ記事を足す（TASKS E-7）。
 *
 * **新しい版を作らない。** STEP 4 は STEP 3 と同じ構成表の続きで、
 * 版を分けると「収益記事だけの版」と「集客記事だけの版」に割れる。
 *
 * `sequence_no` は既存の続きから振る（`(content_plan_id, sequence_no)` が
 * 一意）。
 */
export async function appendItemsToPlanForUser(params: {
  userId: string;
  blogId: string;
  contentPlanId: string;
  items: readonly Omit<NewContentItem, 'sequenceNo'>[];
}): Promise<AppContentItem[]> {
  const blog = await requireBlogForUser(params);

  return prisma.$transaction(async (tx) => {
    // **このブログの構成表であることを確かめる。** `contentPlanId` は
    // 呼び出し側から渡ってくる（C-6 と同じ形の穴を作らない）
    const plan = await tx.contentPlan.findFirst({
      where: { id: params.contentPlanId, blogId: blog.id },
      select: { id: true },
    });

    if (plan === null) {
      throw planNotFoundError();
    }

    const last = await tx.contentItem.findFirst({
      where: { contentPlanId: plan.id },
      orderBy: { sequenceNo: 'desc' },
      select: { sequenceNo: true },
    });

    let sequenceNo = last?.sequenceNo ?? 0;
    const created: AppContentItem[] = [];

    for (const item of params.items) {
      sequenceNo += 1;

      const row = await tx.contentItem.create({
        data: {
          contentPlanId: plan.id,
          blogId: blog.id,
          sequenceNo,
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

      created.push(toAppItem(row));
    }

    return created;
  });
}

/**
 * リンクを保存する（TASKS E-7）。
 *
 * **`blog_id` を条件に含める。** 記事IDは呼び出し側から渡ってくるため、
 * 含めないと他人の記事のリンクを書き換えられる（C-6 と同じ形）。
 */
export async function saveLinksForUser(params: {
  userId: string;
  blogId: string;
  outbound: ReadonlyMap<string, readonly string[]>;
  inbound: ReadonlyMap<string, readonly string[]>;
}): Promise<number> {
  const blog = await requireBlogForUser(params);
  let updated = 0;

  for (const [itemId, ids] of params.outbound) {
    const result = await prisma.contentItem.updateMany({
      where: { id: itemId, blogId: blog.id },
      data: { outboundLinkItemIds: [...ids] },
    });
    updated += result.count;
  }

  for (const [itemId, ids] of params.inbound) {
    const result = await prisma.contentItem.updateMany({
      where: { id: itemId, blogId: blog.id },
      data: { inboundLinkItemIds: [...ids] },
    });
    updated += result.count;
  }

  return updated;
}

/**
 * 制約チェックに要る形で記事を引く（TASKS E-8）。
 *
 * `listContentItemsForUser` はリンクと公開週を返さない（画面向け）。
 * **判定は実際に保存された値で行う** — 組み立ての途中の値ではなく、
 * DBに入ったものを見る。
 */
export async function listPlanItemsWithLinksForUser(params: {
  userId: string;
  blogId: string;
  contentPlanId: string;
}): Promise<
  {
    id: string;
    contentType: ContentType;
    /** 構成表の並び。公開順序（E-9）が使う */
    sequenceNo: number;
    primaryKeyword: string | null;
    outboundLinkItemIds: string[];
    inboundLinkItemIds: string[];
    plannedPublishWeek: number | null;
  }[]
> {
  const blog = await requireBlogForUser(params);

  const rows = await prisma.contentItem.findMany({
    where: { blogId: blog.id, contentPlanId: params.contentPlanId },
    orderBy: [{ sequenceNo: 'asc' }],
    select: {
      id: true,
      contentType: true,
      sequenceNo: true,
      primaryKeyword: true,
      outboundLinkItemIds: true,
      inboundLinkItemIds: true,
      plannedPublishWeek: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    contentType: row.contentType as ContentType,
  }));
}

/**
 * 公開順序を保存する（TASKS E-9）。
 *
 * **`blog_id` を条件に含める。** 記事IDは呼び出し側から渡ってくる
 * （C-6 と同じ形の穴を作らない）。
 */
export async function savePublishOrderForUser(params: {
  userId: string;
  blogId: string;
  slots: readonly {
    itemId: string;
    publishPriority: number;
    plannedPublishWeek: number;
  }[];
}): Promise<number> {
  const blog = await requireBlogForUser(params);
  let updated = 0;

  for (const slot of params.slots) {
    const result = await prisma.contentItem.updateMany({
      where: { id: slot.itemId, blogId: blog.id },
      data: {
        publishPriority: slot.publishPriority,
        plannedPublishWeek: slot.plannedPublishWeek,
      },
    });

    updated += result.count;
  }

  return updated;
}

/**
 * 記事を「承認待ち」にする（F-1）。
 *
 * **`content_items` を触ってよいのはこのモジュールだけ**（MODULE_RULES 1）。
 * 提案を作るのは `approvals` だが、状態の遷移はここを通す。
 *
 * **`PLANNED` のものだけを進める。** 既に承認済み・投稿済みの記事を
 * 巻き戻さないため、条件に状態を入れる。
 *
 * @returns 実際に進めた件数
 */
export async function markItemsReadyForReview(
  contentItemIds: readonly string[],
): Promise<number> {
  if (contentItemIds.length === 0) {
    return 0;
  }

  const updated = await prisma.contentItem.updateMany({
    where: { id: { in: [...contentItemIds] }, status: 'PLANNED' },
    data: { status: 'READY_FOR_REVIEW' },
  });

  return updated.count;
}
