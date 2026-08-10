import { z } from 'zod';
import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  REVISION_COMMENT_MAX_LENGTH,
  REVISION_REQUEST_TYPES,
  requestRevisionForUser,
} from '@/modules/approvals';

/**
 * `POST /api/approvals/[approvalId]/revision`（TASKS F-6、SPEC 13.6）
 *
 * **種類は決まった6つだけ**（SPEC 5.15）。自由記述は `FREE_TEXT` で、
 * そのときは本文が要る（何を直すか分からない依頼を残さない）。
 */

export const runtime = 'nodejs';

const schema = z.object({
  requestType: z.enum(REVISION_REQUEST_TYPES),
  comment: z.string().max(REVISION_COMMENT_MAX_LENGTH).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { approvalId } = await context.params;

    const input = schema.parse(await request.json());

    const approval = await requestRevisionForUser({
      userId: user.id,
      approvalId,
      requestType: input.requestType,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    });

    return Response.json({ status: approval.status });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
