import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { findWordpressConnectionForUser } from '@/modules/wordpress';

/**
 * `GET /api/blogs/:blogId/wordpress`（SPEC 13.3、TASKS C-1）
 *
 * いまの接続の状態を返す。**未接続なら `null`。**
 *
 * ## なぜ後から足したか
 *
 * 接続する（`connect`）・試す（`test`）・切る（`disconnect`）はあったが、
 * **「いまどうなっているか」を聞く入口が無かった。** 画面は、繋ぐ前と
 * 繋いだ後で出すものが違う。**聞けないと、繋いだ後にもう一度
 * 繋ぐ画面を出すことになる。**
 *
 * **認証情報は返さない**（SPEC 5.4・14.2）。`AppWordpressConnection` は
 * 暗号文の列も復号値も持たない。保存されているかは `hasCredentials` で
 * 分かる。
 *
 * 他人のブログは 404（B-3 の方針）。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ blogId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const connection = await findWordpressConnectionForUser({
      userId: user.id,
      blogId,
    });

    return Response.json({ connection });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
