import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import {
  createOfferFromCatalogForUser,
  listSelectableCatalog,
} from '@/modules/affiliate';
import { requireConsentedUser } from '@/modules/auth';
import { requireBlogForUser } from '@/modules/blogs';

/**
 * `GET|POST /api/blogs/:blogId/offers/catalog`（Q-058・Q-055、段8）
 *
 * 運営が用意した案件から選んで登録する。
 *
 * ## GET は選べるものだけ
 *
 * 下書きも掲載禁止も出さない（`listSelectableCatalog`）。
 * **カタログは全モニター共通**なので、他人のものは含まれない。
 *
 * ## POST が受け取るのは3つだけ
 *
 * **カタログのID・アフィリエイトリンク・使ったことがあるか。**
 * 名前も報酬額も事実も、**サーバーがカタログから読む**
 * （`createOfferFromCatalogForUser`）。渡させると、
 * **カタログを選んだのに中身は別物**という行が作れてしまう。
 *
 * ## リンクは後からでよい
 *
 * **提携が承認されるまでリンクは発行できない**（Q-060）。
 * 承認を待つ間に登録できないと、モニターは「あの案件を申請した」ことを
 * **覚えておくしかない。** 提携が承認されていない案件は
 * **記事候補に入らない**ので、先に登録しても記事にはならない。
 */

export const runtime = 'nodejs';

const USER_EXPERIENCES = ['USED', 'NOT_USED', 'UNKNOWN'] as const;

const schema = z.object({
  catalogItemId: z.string().uuid(),
  /**
   * **提携が承認されるまで発行できない**ので省略できる（Q-060）。
   * 省略したときは `applied` が提携状態を決める
   */
  affiliateUrl: z.string().max(2_000).optional(),
  /** リンクがまだ無いとき、**ASPへ申請済みか**（本人にしか分からない） */
  applied: z.boolean().optional(),
  userExperience: z.enum(USER_EXPERIENCES),
  userRating: z.number().int().min(1).max(5).optional(),
});

type Context = { params: Promise<{ blogId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    // **自分のブログでなければ出さない**（C-6 と同じ形の穴を作らない）
    await requireBlogForUser({ userId: user.id, blogId });

    const items = await listSelectableCatalog();

    // **リンクの出し方と否認条件は画面に要らない。** 運営の判断で、
    // モニターが変えられるものではない（Q-001・Q-014）
    return Response.json({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        aspName: item.aspName,
        advertiserName: item.advertiserName,
        landingPageUrl: item.landingPageUrl,
        rewardYen: item.rewardYen,
        conversionType: item.conversionType,
        facts: item.facts,
        genreHints: item.genreHints,
      })),
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('入力を確かめてください');
    }

    const offer = await createOfferFromCatalogForUser(
      { userId: user.id, blogId },
      parsed.data,
    );

    return Response.json({ offer }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
