import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  activatePersonaForUser,
  getPersonaLimitsForUser,
  pausePersonaForUser,
} from '@/modules/personas';

/**
 * `POST /api/personas/:personaId/status`（TASKS D-14）。
 *
 * 使い始める（`ACTIVATE`）／止める（`PAUSE`）。
 *
 * **状態ごとに別のURLを作らない。** `/activate` と `/pause` に分けると、
 * 状態が増えるたびにURLが増える。**何をするかは本文で受ける。**
 *
 * **成功時に `limits` を一緒に返す。** 使い始めた直後に「あと何体使えるか」が
 * 変わるので、画面が数え直さずに済む。断られたときの理由は
 * `activatePersonaForUser` の文言が経過日数まで含んでいる。
 */

export const runtime = 'nodejs';

const bodySchema = z.object({ action: z.enum(['ACTIVATE', 'PAUSE']) });

type Context = { params: Promise<{ personaId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { personaId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('操作を確認してください');
    }

    const persona =
      parsed.data.action === 'ACTIVATE'
        ? await activatePersonaForUser({ userId: user.id, personaId })
        : await pausePersonaForUser({ userId: user.id, personaId });

    return Response.json({
      persona,
      limits: await getPersonaLimitsForUser(user.id),
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
