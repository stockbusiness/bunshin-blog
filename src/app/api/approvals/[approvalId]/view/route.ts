import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { markViewedForUser } from '@/modules/approvals';

/**
 * `POST /api/approvals/[approvalId]/view`（TASKS F-6、SPEC 13.6）
 *
 * **読み取りと分ける。** `GET` で状態が変わると、一覧を先読みしただけで
 * 「開いた」ことになる。
 */

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { approvalId } = await context.params;

    const approval = await markViewedForUser({ userId: user.id, approvalId });

    return Response.json({ status: approval.status });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
