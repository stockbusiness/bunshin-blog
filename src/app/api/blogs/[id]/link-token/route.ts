import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { issueLinkEventTokenForUser } from '@/modules/blogs';

/**
 * `POST /api/blogs/:id/link-token` 受信APIのトークンを発行する（TASKS D-12）。
 *
 * **原文を返すのはここだけ。** DBにはハッシュしか無いので、二度と出せない。
 * 画面は「もう一度見る」を作らず、**必要なら作り直す**。
 *
 * **GET を作らない。** 取得の入口があると、セッションを奪われたときに
 * トークンまで持ち出せる。作り直せば古いものは効かなくなる。
 *
 * 他人のブログは 404（SPEC 14.1）。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;

    const issued = await issueLinkEventTokenForUser({
      userId: user.id,
      blogId: id,
    });

    return Response.json({
      // **一度だけ。** 画面はこの応答をそのまま見せ、保存しない
      token: issued.token,
      issuedAt: issued.issuedAt.toISOString(),
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
