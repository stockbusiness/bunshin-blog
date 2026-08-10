import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { approveForUser } from '@/modules/approvals';

/**
 * `POST /api/approvals/[approvalId]/approve`（TASKS F-6、SPEC 13.6）
 *
 * **二度送っても成功する**（冪等）。違う答えを送ると 409。
 * WordPress への投稿は F-7。
 */

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { approvalId } = await context.params;

    const approval = await approveForUser({ userId: user.id, approvalId });

    return Response.json({ status: approval.status });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
