import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireUser } from '@/modules/auth';
import { acceptConsentForUser } from '@/modules/users';

/**
 * `POST /api/onboarding/consent` 同意を記録する（TASKS H-2b、SPEC 6.1）。
 *
 * **`requireConsentedUser` では守れない。** 同意そのものがここなので、
 * 同意済みでないと通れない入口にすると詰む。
 *
 * **取り消しの入口は作らない。** 取り消しは退会（H-4）で扱う。
 * 「同意を外す」だけを許すと、データを残したまま同意が無い状態ができる。
 */

export const runtime = 'nodejs';

const bodySchema = z.object({ kind: z.enum(['TERMS', 'DATA_USE']) });

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireUser(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('同意の種類を確認してください');
    }

    const updated = await acceptConsentForUser({
      userId: user.id,
      kind: parsed.data.kind,
    });

    return Response.json({
      consents: {
        terms: updated.termsAcceptedAt !== null,
        dataUse: updated.dataUseConsentAt !== null,
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
