import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { draftOfferFromLandingPage } from '@/modules/affiliate';
import { requireAdmin } from '@/modules/auth';
import { createConfiguredAiProvider } from '@/modules/settings';

/**
 * `POST /api/admin/offer-catalog/draft`（Q-055、Q-053）
 *
 * 紹介先のページを読んで、カタログの**下書き**を返す。**ADMIN だけ。**
 *
 * ## モニター側と同じ道具を使う
 *
 * Q-053 で作った `draftOfferFromLandingPage` をそのまま使う。
 * **読み取りの正しさを2か所に持たない。**
 *
 * ## 保存しない
 *
 * **ここは読むだけ。** 返した下書きは画面に出て、
 * **人が直してから** `POST /api/admin/offer-catalog` で登録される。
 * カタログの `facts` は**30ブログに広がる**ので、なおさら人が確かめる。
 */

export const runtime = 'nodejs';

const schema = z.object({
  landingPageUrl: z.string().min(1).max(2_000),
});

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

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
