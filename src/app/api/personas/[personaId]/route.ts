import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  requirePersonaForUser,
  updatePersonaForUser,
} from '@/modules/personas';

/**
 * `GET|PATCH /api/personas/:personaId`（TASKS D-14）。
 *
 * **他人の分身は 404 を返す。** 403 だと「そのIDは存在する」と伝わり、
 * IDの総当たりで他ユーザーの資源の有無を調べられる（SPEC 14.1）。
 *
 * **削除の入口は作らない。** 使うのをやめるのは `PAUSED`、畳むのは
 * `ARCHIVED`（D-14 では `PAUSED` まで）。**途中でやめた分身があること自体が
 * 実験の結果**で、消すと「最初から作らなかった」と区別できない。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ personaId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { personaId } = await context.params;

    const persona = await requirePersonaForUser({ userId: user.id, personaId });

    return Response.json({ persona });
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
    const { personaId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const persona = await updatePersonaForUser(
      { userId: user.id, personaId },
      body,
    );

    return Response.json({ persona });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
