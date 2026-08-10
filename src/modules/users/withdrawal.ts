/**
 * 退会とデータの持ち出し（TASKS H-4、SPEC 13.2）。
 *
 * 完了条件は「**物理削除せずCLOSED。データエクスポートができる**」。
 *
 * ## 消さない
 *
 * 退会しても行は残す（SPEC 13.2「削除は物理削除せずCLOSED」）。
 * Phase 0 は**10名がどこまで続いたかを見る実験**（SPEC 1.2）で、
 * 抜けた人の記録を消すと「10名中何名が続いたか」が数えられなくなる。
 *
 * ブログは `CLOSED` にする。**スロットは戻さない**（Q-008）— 戻すと
 * 「3枠のうち何枠を使ったか」が後から分からなくなる。
 *
 * ## 退会は戻せない
 *
 * `WITHDRAWN` からは動かせない（H-1 の遷移表）。停止（`PAUSED`）と
 * 分けてあるのは、**戻せる操作と戻せない操作を混ぜないため。**
 *
 * **ADMIN 専用。`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 */

import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { recordAuditInTx } from '@/modules/audit';
import { listBlogsForUser } from '@/modules/blogs';
import {
  findUserPersonaForUser,
  listPersonaFactsForUser,
} from '@/modules/personas';
import { listApprovalSummariesForUser } from '@/modules/approvals';
import { listContentItemsForUser } from '@/modules/content-planning';
import { listArticleVersionsForUser } from '@/modules/content-generation';
import { listOffersForUser } from '@/modules/affiliate';
import type { AppUser } from './types';

export const WITHDRAWAL_ERROR_CODES = {
  notFound: 'MONITOR_NOT_FOUND',
} as const;

function notFoundError(): AppError {
  return new AppError(
    WITHDRAWAL_ERROR_CODES.notFound,
    404,
    'モニターが見つかりません',
  );
}

export interface WithdrawResult {
  user: AppUser;
  /** 閉じたブログの件数（既に閉じていたものは含めない） */
  closedBlogs: number;
}

/**
 * 退会させる。
 *
 * **利用者の行もブログの行も消さない。** 状態を変えるだけ。
 *
 * **二度呼んでも成功する**（冪等）。既に `WITHDRAWN` なら何も変えずに返す。
 *
 * @throws {AppError} モニターが見つからない
 */
export async function withdrawMonitorForAdmin(params: {
  userId: string;
  actorUserId: string | null;
}): Promise<WithdrawResult> {
  const current = await prisma.user.findFirst({
    where: { id: params.userId, role: 'MONITOR' },
    select: { status: true },
  });

  if (current === null) {
    throw notFoundError();
  }

  if (current.status === 'WITHDRAWN') {
    return { user: await readUser(params.userId), closedBlogs: 0 };
  }

  // **利用者の状態・ブログ・記録は同時に決まる。** 途中で落ちて
  // 「退会したのにブログが動いている」状態を作らない
  const closedBlogs = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: params.userId },
      data: { status: 'WITHDRAWN' },
    });

    // **物理削除しない**（SPEC 13.2）。`CLOSED` にするだけ
    const closed = await tx.blog.updateMany({
      where: { userId: params.userId, status: { not: 'CLOSED' } },
      data: { status: 'CLOSED' },
    });

    await recordAuditInTx(tx, {
      actorUserId: params.actorUserId,
      action: 'MONITOR_WITHDRAWN',
      entityType: 'user',
      entityId: params.userId,
      // **氏名や `line_user_id` を入れない**（SPEC 14.2）
      metadata: { from: current.status, closedBlogs: closed.count },
    });

    return closed.count;
  });

  return { user: await readUser(params.userId), closedBlogs };
}

async function readUser(userId: string): Promise<AppUser> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      displayName: true,
      status: true,
      termsAcceptedAt: true,
      dataUseConsentAt: true,
    },
  });

  return {
    id: row.id,
    role: row.role as AppUser['role'],
    displayName: row.displayName,
    status: row.status as AppUser['status'],
    termsAcceptedAt: row.termsAcceptedAt,
    dataUseConsentAt: row.dataUseConsentAt,
  };
}

export interface UserDataExport {
  exportedAt: string;
  user: {
    id: string;
    displayName: string;
    status: string;
    termsAcceptedAt: string | null;
    dataUseConsentAt: string | null;
  };
  blogs: {
    id: string;
    name: string;
    slug: string;
    status: string;
    slotNumber: number;
    offers: { id: string; name: string; aspName: string; status: string }[];
    articles: {
      contentItemId: string;
      title: string;
      status: string;
      versions: { versionNo: number; title: string; bodyHtml: string }[];
    }[];
  }[];
  persona: unknown;
  personaFacts: { id: string; factType: string; content: string }[];
  approvals: {
    id: string;
    blogName: string;
    articleTitle: string;
    status: string;
    respondedAt: string | null;
  }[];
}

/**
 * 利用者のデータを持ち出せる形にまとめる（完了条件）。
 *
 * ## 秘密は入れない
 *
 * **WordPress の認証情報・Google の refresh token・APIキーは含めない**
 * （SPEC 14.2）。暗号化して保存しているものは、復号して出す先を作らない。
 *
 * **`line_user_id` も入れない。** LINE の身元そのもので、
 * 出力の行き先が増えるほど漏れる面が広がる（F-2 と同じ扱い）。
 *
 * ## `CLOSED` のブログも含める
 *
 * 退会したあとに持ち出すため、閉じたブログを外すと**何も入っていない
 * ファイル**が出てくる。
 *
 * **ADMIN 専用。`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 */
export async function exportUserDataForAdmin(
  userId: string,
  now: Date = new Date(),
): Promise<UserDataExport> {
  const user = await prisma.user.findFirst({
    where: { id: userId, role: 'MONITOR' },
    select: {
      id: true,
      displayName: true,
      status: true,
      termsAcceptedAt: true,
      dataUseConsentAt: true,
    },
  });

  if (user === null) {
    throw notFoundError();
  }

  // **閉じたブログも含める**（退会後に持ち出すため）
  const blogs = await listBlogsForUser(userId, { includeClosed: true });

  const [persona, facts, approvals] = await Promise.all([
    findUserPersonaForUser(userId),
    listPersonaFactsForUser(userId),
    listApprovalSummariesForUser(userId),
  ]);

  const exportedBlogs = [];

  for (const blog of blogs) {
    exportedBlogs.push({
      id: blog.id,
      name: blog.name,
      slug: blog.slug,
      status: blog.status,
      slotNumber: blog.slotNumber,
      offers: await readOffers({ userId, blogId: blog.id }),
      articles: await readArticles({ userId, blogId: blog.id }),
    });
  }

  return {
    exportedAt: now.toISOString(),
    user: {
      id: user.id,
      displayName: user.displayName,
      status: user.status,
      termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
      dataUseConsentAt: user.dataUseConsentAt?.toISOString() ?? null,
    },
    blogs: exportedBlogs,
    persona,
    personaFacts: facts.map((fact) => ({
      id: fact.id,
      factType: fact.factType,
      content: fact.content,
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      blogName: approval.blogName,
      articleTitle: approval.articleTitle,
      status: approval.status,
      respondedAt: approval.respondedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * 案件を読む。
 *
 * **`CLOSED` のブログでは読めない**（`listOffersForUser` が弾く）。
 * 退会後は全てのブログが `CLOSED` なので、そこは空になる —
 * 案件はASPの情報で、**持ち出す価値があるのは記事のほう**。
 */
async function readOffers(params: {
  userId: string;
  blogId: string;
}): Promise<{ id: string; name: string; aspName: string; status: string }[]> {
  try {
    const offers = await listOffersForUser(params);

    return offers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      aspName: offer.aspName,
      status: offer.status,
    }));
  } catch {
    return [];
  }
}

async function readArticles(params: {
  userId: string;
  blogId: string;
}): Promise<UserDataExport['blogs'][number]['articles']> {
  let items;

  try {
    items = await listContentItemsForUser(params);
  } catch {
    return [];
  }

  const articles = [];

  for (const item of items) {
    const versions = await listArticleVersionsForUser({
      ...params,
      contentItemId: item.id,
    });

    articles.push({
      contentItemId: item.id,
      title: item.title,
      status: item.status,
      // **本文まで入れる。** タイトルだけでは持ち出す意味が薄い
      versions: versions.map((version) => ({
        versionNo: version.versionNo,
        title: version.title,
        bodyHtml: version.bodyHtml,
      })),
    });
  }

  return articles;
}
