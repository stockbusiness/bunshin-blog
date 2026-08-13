import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  ISSUE_DESCRIPTION_MAX_LENGTH,
  ISSUE_SEVERITIES,
  recordFactIssueForAdmin,
} from '@/modules/content-generation';

/**
 * `POST /api/admin/fact-issues`（TASKS J-7、OPEN_QUESTIONS Q-044）
 *
 * 事実誤認を記録する。**ADMIN だけ。**
 *
 * ## モニターからも受け取らない
 *
 * モニターが見つけたものも **ADMIN が代わりに入れる。** 経路を分けると
 * **集計が2か所を見る**ことになり、片方を数え忘れたときに率が良く出る。
 *
 * SPEC 16.2 が見るのは「重大な事実誤認を公開前に捕まえられたか」で、
 * **率が良く出る方向の間違いをいちばん避けたい。**
 */

export const runtime = 'nodejs';

const schema = z.object({
  articleVersionId: z.string().uuid(),
  severity: z.enum(ISSUE_SEVERITIES as unknown as [string, ...string[]]),
  description: z.string().min(1).max(ISSUE_DESCRIPTION_MAX_LENGTH),
  caughtBeforePublish: z.boolean(),
  // **見つけた日を受け取る。** 記録した日ではない（後からまとめて入れうる）
  foundAt: z.string().datetime(),
  // **見つけた人。** ADMIN が代わりに入れているだけなので、
  // **入れた人を見つけた人にしない。** 分からなければ省く
  foundByUserId: z.string().uuid().nullable().optional(),
});

export async function POST(request: Request): Promise<Response> {
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
      throw AppError.validationFailed('記録の内容を確認してください');
    }

    const issue = await recordFactIssueForAdmin({
      articleVersionId: parsed.data.articleVersionId,
      severity: parsed.data.severity as 'MAJOR' | 'MINOR',
      description: parsed.data.description,
      caughtBeforePublish: parsed.data.caughtBeforePublish,
      foundAt: new Date(parsed.data.foundAt),
      // **入れた人を「見つけた人」にしない。** ADMIN は代わりに
      // 入れているだけで、見つけたのは読者やモニターのことがある。
      // **分からないなら `null` のまま**（推測で誰かの名前を入れない）
      foundByUserId: parsed.data.foundByUserId ?? null,
    });

    return Response.json({ issue }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
