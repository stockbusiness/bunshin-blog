import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { createBlogForUser, listBlogsForUser } from '@/modules/blogs';

/**
 * `GET /api/blogs` / `POST /api/blogs`（SPEC 13.2、TASKS B-3）
 *
 * **一覧はセッションのユーザーで絞る。** クエリでユーザーを指定させない
 * （SPEC 14.1）。
 */

export const runtime = 'nodejs';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, {
      message: '英小文字・数字・ハイフンのみ',
    }),
  targetReader: z.string().min(1).max(500),
  slotNumber: z.number().int().min(1).max(3),
  penName: z.string().max(100).optional(),
  purpose: z.enum(['AFFILIATE', 'DISPLAY_AD', 'MIXED']).optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const blogs = await listBlogsForUser(user.id);

    return Response.json({ blogs });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('ブログの内容を確認してください');
    }

    // userId は入力からではなくセッションから取る
    const blog = await createBlogForUser(user.id, parsed.data);

    return Response.json({ blog }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
