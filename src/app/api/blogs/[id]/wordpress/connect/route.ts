import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  APP_PASSWORD_MAX_LENGTH,
  SITE_URL_MAX_LENGTH,
  WP_USERNAME_MAX_LENGTH,
  connectWordpressForUser,
} from '@/modules/wordpress';

/**
 * `POST /api/blogs/:id/wordpress/connect`（SPEC 13.3、TASKS C-1）
 *
 * **レスポンスに認証情報を含めない**（SPEC 5.4・14.2）。
 * 返すのは `AppWordpressConnection` で、暗号文の列も復号値も持たない。
 *
 * **接続先の変更は 409 で拒否する**（OPEN_QUESTIONS Q-007）。
 * 他人のブログは 404（B-3 の方針）。
 */

export const runtime = 'nodejs';

const connectSchema = z.object({
  siteUrl: z.string().min(1).max(SITE_URL_MAX_LENGTH),
  wpUsername: z.string().min(1).max(WP_USERNAME_MAX_LENGTH),
  // 表示どおり貼り付けると空白が入る。長さの上限は空白込みで見る
  appPassword: z
    .string()
    .min(1)
    .max(APP_PASSWORD_MAX_LENGTH * 2),
});

type Context = { params: Promise<{ id: string }> };

export async function POST(
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

    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      // **何が不正だったかを返さない。** 入力にパスワードが含まれるため、
      // zod の issue をそのまま返すと値が混ざりうる
      throw AppError.validationFailed('接続情報を確認してください');
    }

    const connection = await connectWordpressForUser(
      { userId: user.id, blogId: id },
      parsed.data,
    );

    return Response.json({ connection });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
