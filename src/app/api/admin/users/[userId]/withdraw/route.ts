import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { withdrawMonitorForAdmin } from '@/modules/users';

/**
 * `POST /api/admin/users/[userId]/withdraw`（TASKS H-4、SPEC 13.2）
 *
 * **状態変更（`/status`）と別の入口にする。** 退会は戻せない操作で、
 * 停止と同じ引数の一種にすると、値を間違えたときの結果が重すぎる。
 *
 * **物理削除しない。** 利用者もブログも行は残り、状態だけが変わる。
 */

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));
    const { userId } = await context.params;

    const result = await withdrawMonitorForAdmin({
      userId,
      actorUserId: admin.id,
    });

    return Response.json({
      status: result.user.status,
      closedBlogs: result.closedBlogs,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
