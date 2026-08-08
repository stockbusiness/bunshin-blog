import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { testWordpressConnectionForUser } from '@/modules/wordpress';

/**
 * `POST /api/blogs/:id/wordpress/test`（SPEC 13.3・7.2、TASKS C-2）
 *
 * **7項目の結果を全て返す。** 「接続できません」だけでは、モニターが
 * 何を直せばよいか分からない（完了条件「権限不足を個別のエラーコードで返す」）。
 *
 * **失敗しても 200 を返す。** テストの実行そのものは成功しており、
 * 結果が「繋がらない」なだけ。HTTPのエラーにすると、実行できなかった場合と
 * 区別がつかなくなる。所有権・未接続はこれまでどおり 404。
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

    const result = await testWordpressConnectionForUser({
      userId: user.id,
      blogId: id,
    });

    return Response.json({ result });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
