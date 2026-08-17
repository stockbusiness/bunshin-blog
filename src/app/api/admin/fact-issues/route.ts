import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import {
  ISSUE_DESCRIPTION_MAX_LENGTH,
  recordFactIssueForAdmin,
  updateFactIssueFixForAdmin,
  type FactIssueFixStatus,
  type FactIssueSource,
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

/** **ここで組み立てる**（`z.enum` に型のある組を渡すため） */
const SEVERITIES = ['MAJOR', 'MINOR'] as const;

const SOURCES = [
  'MONITOR_REPORT',
  'SAMPLING',
  'OPERATOR',
  'READER',
  'OTHER',
] as const;

const FIX_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'FIXED',
  'WONT_FIX',
] as const;

const schema = z.object({
  articleVersionId: z.string().uuid(),
  severity: z.enum(SEVERITIES),
  description: z.string().min(1).max(ISSUE_DESCRIPTION_MAX_LENGTH),
  caughtBeforePublish: z.boolean(),
  // **見つけた日を受け取る。** 記録した日ではない（後からまとめて入れうる）
  foundAt: z.string().datetime(),
  // **見つけた人。** ADMIN が代わりに入れているだけなので、
  // **入れた人を見つけた人にしない。** 分からなければ省く
  foundByUserId: z.string().uuid().nullable().optional(),
  // **どこから見つかったか。** 省けない — 機械の見逃しか、抜き取りか、
  // 読者の指摘かで打つ手が違う（2026-08-17 の決定）
  foundVia: z.enum(SOURCES),
});

/** 直したかを記録する（`PATCH`） */
const fixSchema = z.object({
  id: z.string().uuid(),
  fixStatus: z.enum(FIX_STATUSES),
  fixedAt: z.string().datetime().optional(),
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
      severity: parsed.data.severity,
      description: parsed.data.description,
      caughtBeforePublish: parsed.data.caughtBeforePublish,
      foundAt: new Date(parsed.data.foundAt),
      // **入れた人を「見つけた人」にしない。** ADMIN は代わりに
      // 入れているだけで、見つけたのは読者やモニターのことがある。
      // **分からないなら `null` のまま**（推測で誰かの名前を入れない）
      foundByUserId: parsed.data.foundByUserId ?? null,
      foundVia: parsed.data.foundVia as FactIssueSource,
    });

    return Response.json({ issue }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

/**
 * 直したかを記録する。
 *
 * **記録しただけで直っていないのがいちばん悪い**（2026-08-17 の決定）。
 * 直した記録が残らないと、`fact_issues` は「起きたこと」の山になる。
 */
export async function PATCH(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = fixSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('記録の内容を確認してください');
    }

    const issue = await updateFactIssueFixForAdmin(parsed.data.id, {
      fixStatus: parsed.data.fixStatus as FactIssueFixStatus,
      ...(parsed.data.fixedAt === undefined
        ? {}
        : { fixedAt: new Date(parsed.data.fixedAt) }),
    });

    return Response.json({ issue });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
