import { AppError, toErrorHttpResponse } from '@/lib/errors';
import {
  createCatalogItemForAdmin,
  listCatalogForAdmin,
} from '@/modules/affiliate';
import { requireAdmin } from '@/modules/auth';
import { catalogItemSchema } from './schema';

/**
 * `GET|POST /api/admin/offer-catalog`（Q-055、段8）
 *
 * 運営が用意する案件の元。**ADMIN だけ。**
 *
 * ## なぜモニターに書かせないか
 *
 * `link_mode`・`sub_id_param`・`blog_posting_prohibited` は
 * **ASPの規約の判断**で、もともとADMINが決める列（Q-001・Q-014・Q-019）。
 * `facts` は**記事に書ける数値の出どころ**（SPEC 9.6）で、
 * ここが間違うと30ブログすべてに広がる。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    return Response.json({ items: await listCatalogForAdmin() });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

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

    const item = await createCatalogItemForAdmin(parsed.data, admin.id);

    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
