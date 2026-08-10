import { z } from 'zod';
import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { updateMonitorStatusForAdmin } from '@/modules/users';

/**
 * `POST /api/admin/users/[userId]/status`（TASKS H-1、SPEC 6.2）
 *
 * **ADMIN 専用。** 実験への参加は「登録できた」ではなく
 * 「ADMIN が認めた」で決まる（`INVITED` のままではアプリを使えない）。
 *
 * **退会はここに置かない**（H-4）。戻せない操作を同じ入口に混ぜない。
 */

export const runtime = 'nodejs';

const schema = z.object({
  action: z.enum(['ACTIVATE', 'PAUSE', 'RESUME']),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

    const { userId } = await context.params;
    const { action } = schema.parse(await request.json());

    // **誰が介入したかを残す**（H-11、Q-008 の決定）
    const user = await updateMonitorStatusForAdmin({
      userId,
      action,
      actorUserId: admin.id,
    });

    return Response.json({ status: user.status });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
