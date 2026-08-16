import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  RICH_MENU_DESTINATIONS,
  readRichMenu,
  saveRichMenu,
} from '@/modules/line';
import { getRuntimeEnv } from '@/modules/settings';

/**
 * `GET|PUT /api/admin/rich-menu`（Q-054、TASKS H-6）
 *
 * LINEのリッチメニューの**下書き**。**ADMIN だけ。**
 *
 * ## なぜモニターに開かないか
 *
 * **全モニター共通で1つ**であり、誰かが変えると全員に出るものが変わる。
 * ジャンルのマスタ（`/api/admin/genres`）と同じ理由でここに置く。
 *
 * ## PUT は LINE を触らない
 *
 * **保存するだけ。** LINE に出すのは `POST /api/admin/rich-menu/apply`。
 * 分けているのは、**出す前に画面で確かめられるようにする**ため。
 */

export const runtime = 'nodejs';

const areaSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  label: z.string().min(1).max(20),
  uri: z.string().min(1).max(1_000),
});

const schema = z.object({
  name: z.string().min(1).max(300),
  chatBarText: z.string().min(1).max(14),
  canvas: z.enum(['LARGE', 'COMPACT']),
  selected: z.boolean(),
  // **上限は LINE の仕様。** 細かい決まりは `validateRichMenu` が見る
  areas: z.array(areaSchema).max(20),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    const [richMenu, env] = await Promise.all([
      readRichMenu(),
      getRuntimeEnv(),
    ]);

    return Response.json({
      richMenu,
      /**
       * **行き先を組み立てるのに要る。**（`RICH_MENU_DESTINATIONS`）
       *
       * **1つだけ取り出す。** `getRuntimeEnv()` は秘密の平文を含む辞書を
       * 返すので、そのまま渡さない（SPEC 14.2）。
       */
      liffBaseUrl: env['LIFF_BASE_URL']?.trim() ?? '',
      destinations: RICH_MENU_DESTINATIONS,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

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

    const richMenu = await saveRichMenu(parsed.data, admin.id);

    return Response.json({ richMenu });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
