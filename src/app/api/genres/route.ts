import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { listSelectableGenres } from '@/modules/blogs';

/**
 * `GET /api/genres`（段7、Q-049）
 *
 * ジャンルのマスタを**読むだけ。** モニターも見られる。
 *
 * ## なぜ読ませるのか
 *
 * 段7は**ADMIN が審査を回して付ける**（Q-049 の (b)）。だが
 * **何が候補にあるのかを見られないと、希望の出しようが無い。**
 *
 * ## YMYL も隠さない
 *
 * `HIGH` のジャンルも返す。**隠すと「なぜ選べないのか」が分からない。**
 * 画面側は「選べない」と添えて出す。**止まる理由が見えているほうが、
 * 別のジャンルへ移りやすい。**
 *
 * **足すのは ADMIN だけ**（`/api/admin/genres`）。`ymyl_risk` を
 * 自己申告にすると、停止条件を申告で回避できる。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireConsentedUser(request.headers.get('cookie'));

    return Response.json({ genres: await listSelectableGenres() });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
