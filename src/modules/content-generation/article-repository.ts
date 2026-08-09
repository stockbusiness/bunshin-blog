/**
 * `article_versions` テーブルへのアクセス（TASKS E-10）。
 *
 * **このモジュールだけが `article_versions` を触る**（MODULE_RULES 1）。
 *
 * ## 版を上書きしない
 *
 * 再生成のたびに `version_no` を増やす。**前の版を残す**のは、
 * 修正依頼で作り直したときに「何がどう変わったか」を承認画面（F-5）で
 * 見せるため。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireBlogForUser } from '@/modules/blogs';
import { itemNotInPlanError } from './errors';

export interface AppArticleVersion {
  id: string;
  contentItemId: string;
  versionNo: number;
  title: string;
  excerpt: string;
  answerCapsule: string;
  bodyHtml: string;
  contentHash: string;
  /** 事実チェックの結果（E-12）。生成直後は `NOT_CHECKED` */
  factCheckStatus: string;
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

const SELECT = {
  id: true,
  contentItemId: true,
  versionNo: true,
  title: true,
  excerpt: true,
  answerCapsule: true,
  bodyHtml: true,
  contentHash: true,
  factCheckStatus: true,
  modelProvider: true,
  modelName: true,
  promptVersion: true,
  inputTokens: true,
  outputTokens: true,
  createdAt: true,
} as const;

/**
 * 記事が自分のブログの構成表にあることを確かめる。
 *
 * **単体生成モードを作らない**（E-10 の完了条件）。構成表を経由しない
 * 生成は、内部リンクも公開順序も持たない孤立した記事になる。
 *
 * @throws {AppError} 自分のブログの記事でない
 */
export async function requirePlannedItemForUser(params: {
  userId: string;
  blogId: string;
  contentItemId: string;
}): Promise<{
  id: string;
  title: string;
  primaryKeyword: string | null;
  searchIntent: string;
  contentType: string;
  affiliateOfferId: string | null;
  outboundLinkItemIds: string[];
}> {
  const blog = await requireBlogForUser(params);

  const item = await prisma.contentItem.findFirst({
    // **`blog_id` を条件に入れる。** `contentItemId` は呼び出し側から
    // 渡ってくる（C-6 と同じ形の穴を作らない）
    where: { id: params.contentItemId, blogId: blog.id },
    select: {
      id: true,
      title: true,
      primaryKeyword: true,
      searchIntent: true,
      contentType: true,
      affiliateOfferId: true,
      outboundLinkItemIds: true,
    },
  });

  if (item === null) {
    throw itemNotInPlanError();
  }

  return item;
}

export interface SaveArticleVersionInput {
  contentItemId: string;
  title: string;
  excerpt: string;
  answerCapsule: string;
  bodyHtml: string;
  faq: Prisma.InputJsonValue;
  /** **コードで組み立てた JSON-LD**（E-11、CONTENT_PLANNING 7.3） */
  structuredData: Prisma.InputJsonValue;
  usedFactIds: readonly string[];
  claims: Prisma.InputJsonValue;
  contentHash: string;
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/**
 * 記事の版を保存する。
 *
 * **`version_no` は既存の続き。** 上書きしない。
 */
export async function saveArticleVersion(
  input: SaveArticleVersionInput,
): Promise<AppArticleVersion> {
  return prisma.$transaction(async (tx) => {
    const last = await tx.articleVersion.findFirst({
      where: { contentItemId: input.contentItemId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    });

    return tx.articleVersion.create({
      data: {
        contentItemId: input.contentItemId,
        versionNo: (last?.versionNo ?? 0) + 1,
        title: input.title,
        excerpt: input.excerpt,
        answerCapsule: input.answerCapsule,
        bodyHtml: input.bodyHtml,
        faqJson: input.faq,
        // **AIに作らせない。** `faq` と記事種別からコードで組み立てた値
        // （E-11、CONTENT_PLANNING 7.3）
        structuredDataJson: input.structuredData,
        // **E-12 が判定する。** 生成しただけでは未チェック
        factCheckStatus: 'NOT_CHECKED',
        // **E-13 が入れる**
        riskFlags: [],
        usedFactIds: [...input.usedFactIds],
        unverifiedClaims: input.claims,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        promptVersion: input.promptVersion,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        // **単価が未設定でも記録は残す**（E-14 と同じ扱い）
        estimatedCostUsd: new Prisma.Decimal(input.costUsd ?? 0),
        contentHash: input.contentHash,
      },
      select: SELECT,
    });
  });
}

/**
 * 事実チェックの結果を書く（E-12）。
 *
 * **記事IDと版IDの両方を条件に入れる。** 版IDだけで更新すると、
 * 他人の記事の版に結果を書ける（C-6 と同じ形の穴）。
 *
 * @throws {AppError} その記事の版ではない
 */
export async function saveFactCheckResult(params: {
  contentItemId: string;
  articleVersionId: string;
  status: 'PASSED' | 'WARNING' | 'FAILED';
  unverifiedClaims: Prisma.InputJsonValue;
}): Promise<AppArticleVersion> {
  const updated = await prisma.articleVersion.updateMany({
    where: { id: params.articleVersionId, contentItemId: params.contentItemId },
    data: {
      factCheckStatus: params.status,
      unverifiedClaims: params.unverifiedClaims,
    },
  });

  if (updated.count === 0) {
    throw itemNotInPlanError();
  }

  return prisma.articleVersion.findUniqueOrThrow({
    where: { id: params.articleVersionId },
    select: SELECT,
  });
}

/**
 * 記事の最新の版を引く。
 *
 * **所有権は呼び出し側が `requirePlannedItemForUser` で確かめる。**
 */
export async function findLatestArticleVersion(
  contentItemId: string,
): Promise<AppArticleVersion | null> {
  return prisma.articleVersion.findFirst({
    where: { contentItemId },
    orderBy: [{ versionNo: 'desc' }],
    select: SELECT,
  });
}

/** 記事の版を新しい順に返す */
export async function listArticleVersionsForUser(params: {
  userId: string;
  blogId: string;
  contentItemId: string;
}): Promise<AppArticleVersion[]> {
  await requirePlannedItemForUser(params);

  return prisma.articleVersion.findMany({
    where: { contentItemId: params.contentItemId },
    orderBy: [{ versionNo: 'desc' }],
    select: SELECT,
  });
}

/**
 * 同じ構成表の他の記事を引く（内部リンクと重複タイトルの回避に使う）。
 *
 * **`content-planning` の `listContentItemsForUser` を使わない。**
 * `content-generation → content-planning` は正しい向きだが、
 * ここで要るのは「同じ構成表の記事」で、所有権は
 * `requirePlannedItemForUser` が既に確かめている。
 */
export async function listSiblingItemsForUser(params: {
  userId: string;
  blogId: string;
  contentItemId: string;
}): Promise<{ id: string; title: string; contentType: string }[]> {
  const item = await prisma.contentItem.findFirst({
    where: { id: params.contentItemId },
    select: { contentPlanId: true },
  });

  if (item === null) {
    throw itemNotInPlanError();
  }

  return prisma.contentItem.findMany({
    where: { contentPlanId: item.contentPlanId },
    orderBy: [{ sequenceNo: 'asc' }],
    select: { id: true, title: true, contentType: true },
  });
}
