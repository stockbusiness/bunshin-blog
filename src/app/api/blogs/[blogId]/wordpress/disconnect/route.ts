import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { disconnectWordpressForUser } from '@/modules/wordpress';

/**
 * `DELETE /api/blogs/:blogId/wordpress/disconnect`（SPEC 13.3、TASKS C-1）
 *
 * **行は消さない。`site_url` を残す**（OPEN_QUESTIONS Q-007）。
 * 再接続では保持した `site_url` との一致を確認する。
 * 認証情報は空で上書きし、再接続時に入力し直してもらう。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ blogId: string }> };

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const connection = await disconnectWordpressForUser({
      userId: user.id,
      blogId,
    });

    return Response.json({ connection });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
