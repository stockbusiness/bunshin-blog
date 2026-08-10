import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { listApprovalSummariesForUser } from '@/modules/approvals';

/**
 * `GET /api/approvals`（TASKS F-4、SPEC 6.1 `/liff/approvals`）
 *
 * **一覧はセッションのユーザーで絞る。** クエリでユーザーや承認IDを
 * 指定させない（SPEC 14.1）。完了条件の「他ユーザーの承認を開けない」は、
 * **指定させないこと**で満たす — 指定を受け付けてから弾く形にすると、
 * 弾き忘れが穴になる。
 *
 * 並べ分け（承認待ち／承認済み／修正依頼／見送り）は画面側で行う。
 * 一覧の件数が3ブログ分でも数十件で、**全部返して画面で分けるほうが
 * タブを切り替えるたびに問い合わせるより速い**。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    const approvals = await listApprovalSummariesForUser(user.id);

    return Response.json({
      approvals: approvals.map((approval) => ({
        id: approval.id,
        blogId: approval.blogId,
        blogName: approval.blogName,
        articleTitle: approval.articleTitle,
        status: approval.status,
        proposalType: approval.proposalType,
        proposalReason: approval.proposalReason,
        factCheckStatus: approval.factCheckStatus,
        riskFlagCount: approval.riskFlagCount,
        // **`Date` を渡さない。** JSON を通ると文字列になるため、
        // 画面が `Date` として扱えると誤解しないようここで文字列にする
        sentAt: approval.sentAt?.toISOString() ?? null,
        respondedAt: approval.respondedAt?.toISOString() ?? null,
        createdAt: approval.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
