import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  listFactReviewWeeksForAdmin,
  recordFactReviewWeekForAdmin,
} from '@/modules/content-generation';

/**
 * `GET|POST /api/admin/fact-reviews`（2026-08-17 の決定）
 *
 * 公開済み記事の抜き取り確認を記録する。**ADMIN だけ。**
 *
 * ## なぜ「確かめた」を記録するのか
 *
 * **`fact_issues` が空のとき、それが「誤りが無かった」のか
 * 「確かめていない」のかが分からない。**
 *
 * これは `fact_issues` 自身が解いた問題（見逃しがどこにも残らない）と
 * **同じ形**である。確認した事実を残さないかぎり、空の表は読めない。
 *
 * ## 0件では記録できない
 *
 * `reviewed_count` は1以上（モジュールとDBの両方で断る）。
 * **0件の行は「確認していない」と同じ意味**になり、区別が消える。
 */

export const runtime = 'nodejs';

const schema = z.object({
  /** JSTの月曜（`YYYY-MM-DD`） */
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reviewedCount: z.number().int().min(1).max(1_000),
  issueCount: z.number().int().min(0).max(1_000),
  note: z.string().max(1_000).optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    return Response.json({ weeks: await listFactReviewWeeksForAdmin() });
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

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('記録の内容を確認してください');
    }

    const week = await recordFactReviewWeekForAdmin({
      weekStart: parsed.data.weekStart,
      reviewedCount: parsed.data.reviewedCount,
      issueCount: parsed.data.issueCount,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      // **確かめた人を残す。** 消えても記録は残る（外部キーは SET NULL）
      reviewedByUserId: admin.id,
    });

    return Response.json({ week }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
