import { toErrorHttpResponse } from '@/lib/errors';
import { buildSessionCookie, consumeAdminLoginLink } from '@/modules/auth';

/**
 * `POST /api/admin/login/verify` リンクを使ってログインする（TASKS B-11）。
 *
 * **GET ではなく POST にしている。** メールのリンクを GET で消費すると、
 * 受信側のセキュリティ製品やクライアントがリンクを先読みしただけで
 * トークンが使われ、本人がクリックしたときには使用済みになる。
 * リンク先の画面（`/admin/login/verify`）はボタンを出すだけで、
 * 押したときにここへ POST する。
 */

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const token = form.get('token');

    const { sessionToken } = await consumeAdminLoginLink(
      typeof token === 'string' ? token : '',
    );

    // セッションを渡して管理画面へ送る
    return new Response(null, {
      status: 303,
      headers: {
        location: '/admin',
        'set-cookie': buildSessionCookie(sessionToken),
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
