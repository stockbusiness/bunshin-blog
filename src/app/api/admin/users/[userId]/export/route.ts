import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { exportUserDataForAdmin } from '@/modules/users';

/**
 * `GET /api/admin/users/[userId]/export`（TASKS H-4）
 *
 * 退会するモニターがデータを持ち出せるようにする。
 *
 * **秘密は含まれない**（`exportUserDataForAdmin` が入れない）。
 * WordPress の認証情報・Google の refresh token・`line_user_id` は
 * 出力の対象外（SPEC 14.2）。
 *
 * **ダウンロードとして返す。** 画面に貼り付けるものではなく、
 * 本人へ渡すファイル。
 */

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));
    const { userId } = await context.params;

    const data = await exportUserDataForAdmin(userId);

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="bunshin-export-${userId}.json"`,
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
