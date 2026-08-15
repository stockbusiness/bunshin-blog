import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { draftOfferFromLandingPage } from '@/modules/affiliate';
import { requireConsentedUser } from '@/modules/auth';
import { requireBlogForUser } from '@/modules/blogs';
import { createConfiguredAiProvider } from '@/modules/settings';

/**
 * `POST /api/blogs/:blogId/offers/draft`（Q-053、段8）
 *
 * 紹介先のページを読んで、案件の**下書き**を返す。
 *
 * ## 保存しない
 *
 * **ここは読むだけ。** 返した下書きは画面に出て、**人が直してから**
 * `POST /api/blogs/:blogId/offers` で登録される。
 *
 * **`facts` をここで保存すると `facts_updated_at` が入る**＝
 * 「確かめた」ことになる（D-13・Q-022）。**確かめるのは人。**
 *
 * ## ブログの所有を先に確かめる
 *
 * **確かめずに外部へ取りに行かない。** 他人のブログのIDでも
 * URLさえ渡せば取りに行ける、という形にしない（SPEC 14.1）。
 * 取得そのものは `safeFetch` が守る（C-7）。
 */

export const runtime = 'nodejs';

const schema = z.object({
  landingPageUrl: z.string().min(1).max(2_000),
});

type Context = { params: Promise<{ blogId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    // **先に所有を確かめる**（上記）
    await requireBlogForUser({ userId: user.id, blogId });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('紹介先のページのURLを確かめてください');
    }

    const provider = await createConfiguredAiProvider();

    const draft = await draftOfferFromLandingPage(parsed.data.landingPageUrl, {
      provider,
    });

    return Response.json({ draft });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
