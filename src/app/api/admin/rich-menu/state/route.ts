import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  createConfiguredRichMenuClient,
  describeRichMenuState,
  removeRemoteRichMenu,
} from '@/modules/line';

/**
 * `GET|DELETE /api/admin/rich-menu/state`（Q-054）
 *
 * **いま LINE に何が出ているかを確かめる**（段6の「接続をためす」と同じ）。
 * **ADMIN だけ。**
 *
 * ## 保存した値ではなく LINE に聞く
 *
 * 保存側だけを見ると「出したつもり」が分からない。**食い違いを見せる**
 * のがこの口の仕事。
 *
 * ## DELETE は片づけ
 *
 * **いま出ているものは消せない**（消すと誰にもメニューが出なくなる）。
 * 断るのはモジュール側（`removeRemoteRichMenu`）。
 */

export const runtime = 'nodejs';

const schema = z.object({ richMenuId: z.string().min(1).max(200) });

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    const client = await createConfiguredRichMenuClient();

    return Response.json({ state: await describeRichMenuState({ client }) });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
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
      throw AppError.validationFailed('消すメニューを指定してください');
    }

    const client = await createConfiguredRichMenuClient();
    await removeRemoteRichMenu({ client }, parsed.data.richMenuId);

    return Response.json({ removed: parsed.data.richMenuId });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
