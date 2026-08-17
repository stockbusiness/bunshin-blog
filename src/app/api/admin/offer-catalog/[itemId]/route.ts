import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { updateCatalogItemForAdmin } from '@/modules/affiliate';
import { requireAdmin } from '@/modules/auth';
import { catalogItemSchema } from '../schema';

/**
 * `PUT /api/admin/offer-catalog/:itemId`（Q-055）
 *
 * **`facts` を実際に変えたときだけ `facts_updated_at` が動く**（D-13）。
 * 状態を変えただけで「確かめ直した」ことにしない — すると、
 * **古い価格が「今日確かめた」として記事に出る。**
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ itemId: string }> };

export async function PUT(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));
    const { itemId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = catalogItemSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('入力を確かめてください');
    }

    const item = await updateCatalogItemForAdmin(itemId, parsed.data, admin.id);

    return Response.json({ item });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
