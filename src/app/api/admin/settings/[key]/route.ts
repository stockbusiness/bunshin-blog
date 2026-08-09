import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { clearSettingForAdmin, saveSettingForAdmin } from '@/modules/settings';

/**
 * `PUT|DELETE /api/admin/settings/:key`（TASKS H-9、OPEN_QUESTIONS Q-017）
 *
 * **保存した値を読み返す `GET` を置かない。** 一覧（`/admin/settings`）が
 * 伏せ字で返すところまでで、平文を返す経路は作らない。
 *
 * **`DELETE` は「空文字で保存」ではない。** 行ごと消して、解決順を
 * 環境変数・コード既定へ落とす（H-7-schema）。
 *
 * 名前は `settings` の一覧にあるものだけ。無ければ 404 で、
 * `saveSettingForAdmin` が判定する。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ key: string }> };

export async function PUT(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));
    const { key } = await context.params;
    const body: unknown = await request.json().catch(() => null);

    const value =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['value']
        : undefined;

    const setting = await saveSettingForAdmin({
      key,
      value,
      actorUserId: admin.id,
    });

    return Response.json({ setting });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));
    const { key } = await context.params;

    const setting = await clearSettingForAdmin({ key });

    return Response.json({ setting });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
