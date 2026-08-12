import { toErrorHttpResponse } from '@/lib/errors';
import { recordAudit } from '@/modules/audit';
import { requireAdmin } from '@/modules/auth';
import { retryJobForAdmin } from '@/modules/jobs';

/**
 * `POST /api/admin/jobs/[jobId]/retry`（SPEC 13.7、TASKS H-14）
 *
 * 失敗したジョブを積み直す。**新しい行は作らず、元の行を `QUEUED` へ戻す**
 * （同じ冪等キーでは積めないため。C-4）。
 *
 * ## 中断の印を消したことを残す
 *
 * `output_json` の印（`performOnce`・C-4）は「**外部に副作用が残っている
 * かもしれない**」という意味で、残っている限り再実行は毎回同じ理由で失敗する。
 *
 * **この操作そのものが「人が確かめた」の表明である。** 印を消した場合は
 * **外部の副作用が二重になりうる**ので、消したことを監査ログに残す
 * （SPEC 14.4「ジョブ再実行」）。
 */

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

    const { jobId } = await context.params;
    const { job, clearedCheckpoint } = await retryJobForAdmin(jobId);

    // **誰が積み直したかを残す**（SPEC 14.4）。
    // **入力も出力も入れない**（記事本文や認証情報が入りうる。SPEC 14.2）
    await recordAudit({
      actorUserId: admin.id,
      action: 'JOB_RETRIED',
      entityType: 'job',
      entityId: job.id,
      metadata: {
        jobType: job.jobType,
        // **消したなら、外部の副作用が二重になりうる**（C-4）
        clearedCheckpoint,
      },
    });

    return Response.json({
      job: { id: job.id, jobType: job.jobType, status: job.status },
      clearedCheckpoint,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
