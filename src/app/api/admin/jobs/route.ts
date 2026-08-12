import { toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { listFailedJobsForAdmin } from '@/modules/jobs';

/**
 * `GET /api/admin/jobs`（SPEC 13.7、TASKS H-14）
 *
 * **失敗したジョブだけを返す。** 積み直せるのはこれだけで、
 * 動いているジョブを並べても押せるボタンが無い。
 *
 * **入力と出力（`input_json` / `output_json`）は返さない。**
 * 記事本文も認証情報も入りうる（SPEC 14.2）。どのジョブが、いつ、
 * どんな理由で落ちたかが分かれば足りる。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    const jobs = await listFailedJobsForAdmin();

    return Response.json({ jobs });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
