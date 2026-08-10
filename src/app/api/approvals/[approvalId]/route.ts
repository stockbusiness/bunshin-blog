import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { readApprovalDetailForUser } from '@/modules/approvals';

/**
 * `GET /api/approvals/[approvalId]`（TASKS F-5、SPEC 6.1）
 *
 * **`approvalId` は画面から渡ってくる。** セッションの利用者を必ず条件に
 * 入れる（F-4 の「他ユーザーの承認を開けない」はここでも守る）。
 * 他人のものは 404 で、「無い」と区別しない — 区別すると、IDを変えながら
 * 叩くだけで存在が分かる（SPEC 14.1）。
 */

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { approvalId } = await context.params;

    const detail = await readApprovalDetailForUser({
      userId: user.id,
      approvalId,
    });

    return Response.json({
      approval: {
        id: detail.approval.id,
        blogId: detail.approval.blogId,
        blogName: detail.blogName,
        status: detail.approval.status,
        proposalType: detail.approval.proposalType,
        proposalReason: detail.approval.proposalReason,
      },
      article: {
        versionNo: detail.article.versionNo,
        title: detail.article.title,
        excerpt: detail.article.excerpt,
        answerCapsule: detail.article.answerCapsule,
        bodyHtml: detail.article.bodyHtml,
        faq: detail.article.faq,
        factCheckStatus: detail.article.factCheckStatus,
        unverifiedClaims: detail.article.unverifiedClaims,
        riskFlags: detail.article.riskFlags,
      },
      generation: {
        modelProvider: detail.generation.modelProvider,
        modelName: detail.generation.modelName,
        promptVersion: detail.generation.promptVersion,
        inputTokens: detail.generation.inputTokens,
        outputTokens: detail.generation.outputTokens,
        estimatedCostUsd: detail.generation.estimatedCostUsd,
        // **`Date` を渡さない**（JSON を通ると文字列になる）
        createdAt: detail.generation.createdAt.toISOString(),
      },
      offer: detail.offer,
      banners: detail.banners,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
