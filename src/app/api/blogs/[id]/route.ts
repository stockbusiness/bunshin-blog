import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  WEEKLY_PUBLISH_CAP_MAX,
  WEEKLY_PUBLISH_CAP_MIN,
  closeBlogForUser,
  requireBlogForUser,
  updateBlogForUser,
} from '@/modules/blogs';

/**
 * `GET|PATCH|DELETE /api/blogs/:id`（SPEC 13.2、TASKS B-3）
 *
 * **他人のブログは 404 を返す。** 403 だと「そのIDは存在する」と伝わり、
 * IDの総当たりで他ユーザーの資源の有無を調べられる。
 */

export const runtime = 'nodejs';

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  targetReader: z.string().min(1).max(500).optional(),
  penName: z.string().max(100).nullable().optional(),
  purpose: z.enum(['AFFILIATE', 'DISPLAY_AD', 'MIXED']).optional(),
  status: z.enum(['SETUP', 'ACTIVE', 'PAUSED']).optional(),
  // 投稿頻度（B-5）。article_ratio の他の項目は受け取らない。
  // revenue / traffic は SPEC 9.2.4 の算出値（OPEN_QUESTIONS Q-011）
  weeklyPublishCap: z
    .number()
    .int()
    .min(WEEKLY_PUBLISH_CAP_MIN)
    .max(WEEKLY_PUBLISH_CAP_MAX)
    .optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;
    const blog = await requireBlogForUser({ userId: user.id, blogId: id });

    return Response.json({ blog });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('ブログの内容を確認してください');
    }

    const blog = await updateBlogForUser(
      { userId: user.id, blogId: id },
      parsed.data,
    );

    return Response.json({ blog });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

/** 物理削除しない。`CLOSED` にする（SPEC 13.2） */
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;
    const blog = await closeBlogForUser({ userId: user.id, blogId: id });

    return Response.json({ blog });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
