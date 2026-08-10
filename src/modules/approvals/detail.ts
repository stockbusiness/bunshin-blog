/**
 * 承認の詳細（TASKS F-5、SPEC 6.1 `/liff/approvals/[approvalId]`）。
 *
 * 完了条件は「**未確認事実とリスク警告が表示される**」。
 *
 * ## 読むだけ。状態を変えない
 *
 * SPEC 13.6 は `GET /api/approvals/:id` と `POST /api/approvals/:id/view` を
 * 別々に定めている。**読み取りで状態が変わると、一覧を先読みしただけで
 * 「開いた」ことになる。** 開いた記録は F-6 の `markViewedForUser`。
 */

import {
  readLinkableOfferForUser,
  buildAffiliateLink,
} from '@/modules/affiliate';
import { listBannersForUser } from '@/modules/banners';
import { readArticleVersionDetailForUser } from '@/modules/content-generation';
import { findApprovalForUser, type AppApproval } from './repository';
import { approvalNotFoundError } from './errors';

export interface ApprovalDetail {
  approval: AppApproval;
  blogName: string;
  article: {
    id: string;
    versionNo: number;
    title: string;
    excerpt: string;
    answerCapsule: string;
    bodyHtml: string;
    faq: unknown;
    /** E-12。**完了条件** */
    unverifiedClaims: unknown;
    /** E-13。**完了条件** */
    riskFlags: unknown;
    factCheckStatus: string;
  };
  /** SPEC 6.1「AI生成情報」 */
  generation: {
    modelProvider: string;
    modelName: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: string;
    createdAt: Date;
  };
  /** SPEC 6.1「使用する案件」「アフィリエイトURL」 */
  offer: { name: string; affiliateUrl: string } | null;
  /** SPEC 6.1「バナー」 */
  banners: { id: string; name: string; imageUrl: string; slot: string }[];
}

/**
 * 承認の詳細を読む。
 *
 * **`userId` を必ず条件に入れる。** `approvalId` は画面から渡ってくる
 * （F-4 の完了条件「他ユーザーの承認を開けない」はここでも守る）。
 *
 * @throws {AppError} 自分の承認でない
 */
export async function readApprovalDetailForUser(params: {
  userId: string;
  approvalId: string;
}): Promise<ApprovalDetail> {
  const found = await findApprovalForUser(params);

  if (found === null) {
    throw approvalNotFoundError();
  }

  const article = await readArticleVersionDetailForUser({
    userId: params.userId,
    blogId: found.approval.blogId,
    contentItemId: found.approval.contentItemId,
    articleVersionId: found.approval.articleVersionId,
  });

  const [offer, banners] = await Promise.all([
    readOffer({
      userId: params.userId,
      blogId: found.approval.blogId,
      offerId: found.offerId,
      contentItemId: found.approval.contentItemId,
      slotNumber: found.slotNumber,
    }),
    listBannersForUser({
      userId: params.userId,
      blogId: found.approval.blogId,
    }),
  ]);

  return {
    approval: found.approval,
    blogName: found.blogName,
    article: {
      id: article.id,
      versionNo: article.versionNo,
      title: article.title,
      excerpt: article.excerpt,
      answerCapsule: article.answerCapsule,
      bodyHtml: article.bodyHtml,
      faq: article.faq,
      unverifiedClaims: article.unverifiedClaims,
      riskFlags: article.riskFlags,
      factCheckStatus: article.factCheckStatus,
    },
    generation: {
      modelProvider: article.modelProvider,
      modelName: article.modelName,
      promptVersion: article.promptVersion,
      inputTokens: article.inputTokens,
      outputTokens: article.outputTokens,
      estimatedCostUsd: article.estimatedCostUsd,
      createdAt: article.createdAt,
    },
    offer,
    banners: banners
      .filter((banner) => banner.status === 'ACTIVE')
      .map((banner) => ({
        id: banner.id,
        name: banner.name,
        imageUrl: banner.imageUrl,
        slot: banner.slot,
      })),
  };
}

/**
 * 案件とアフィリエイトURLを読む。
 *
 * **記事に埋めたのと同じURLを見せる。** 承認画面で別のURLを出すと、
 * 確かめたものと公開されるものが食い違う。
 */
async function readOffer(params: {
  userId: string;
  blogId: string;
  offerId: string | null;
  contentItemId: string;
  slotNumber: number;
}): Promise<{ name: string; affiliateUrl: string } | null> {
  if (params.offerId === null) {
    return null;
  }

  const offer = await readLinkableOfferForUser({
    userId: params.userId,
    blogId: params.blogId,
    offerId: params.offerId,
  });

  return {
    name: offer.name,
    affiliateUrl: buildAffiliateLink({
      offer,
      slotNumber: params.slotNumber,
      contentItemId: params.contentItemId,
    }).href,
  };
}
