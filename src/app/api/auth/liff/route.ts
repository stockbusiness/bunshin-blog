import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { authenticateWithLiff, buildSessionCookie } from '@/modules/auth';
import { hasAllConsents, missingConsents } from '@/modules/users';

/**
 * `POST /api/auth/liff`（SPEC 13.1、TASKS B-2）
 *
 * 入力はIDトークンのみ。**ユーザーIDを受け取らない**（SPEC 3.2）。
 * スキーマに無いキーは無視されるため、`user_id` を送られても読まない。
 */

export const runtime = 'nodejs';

const requestSchema = z.object({
  idToken: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.badRequest('idToken が必要です');
    }

    const { user, sessionToken, created } = await authenticateWithLiff(
      parsed.data.idToken,
    );

    const responseBody = {
      user: {
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
      },
      created,
      // 同意が済むまで他のAPIは403になるため、ここで不足を伝える
      consents: {
        completed: hasAllConsents(user),
        missing: missingConsents(user),
      },
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': buildSessionCookie(sessionToken),
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
