import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { applyRichMenu, createConfiguredRichMenuClient } from '@/modules/line';

/**
 * `POST /api/admin/rich-menu/apply`（Q-054）
 *
 * 保存してある下書きを**LINEへ出す。ADMIN だけ。**
 *
 * ## 保存と分けている理由
 *
 * **押すまでは誰にも出ない。** 画面で升目と絵を重ねて確かめてから
 * 押せるようにする。
 *
 * ## 片づけ残りを黙って隠さない
 *
 * 古いメニューを消せなかったときは `staleRichMenuId` が返る。
 * **適用は成っている**が、LINE側に要らないものが残っている。
 */

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

    const client = await createConfiguredRichMenuClient();
    const applied = await applyRichMenu({ client }, admin.id);

    return Response.json({ applied });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
