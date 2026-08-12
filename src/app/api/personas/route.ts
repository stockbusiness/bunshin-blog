import { toErrorHttpResponse } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  createPersonaForUser,
  getPersonaLimitsForUser,
  listPersonasForUser,
} from '@/modules/personas';

/**
 * `GET|POST /api/personas`（TASKS D-14、ROADMAP 2章）。
 *
 * **分身が主、媒体が従。** ブログは分身が無いと作れない（`blogs.persona_id` は
 * `NOT NULL`）ので、ここが最初の入口になる。
 *
 * **一覧は上限の内訳も返す**（`limits`）。「上限です」だけだと、
 * **待てば開くのか、止めれば開くのか、そもそも開かないのか**が画面から
 * 分からない（B-4 の残枠を一緒に返すのと同じ理由）。
 *
 * **入力の検証は `personas` モジュールが持つ**（`normalizeCreatePersona`）。
 * ここで zod を重ねると、同じ規則が2か所になる。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    const [personas, limits] = await Promise.all([
      listPersonasForUser(user.id),
      getPersonaLimitsForUser(user.id),
    ]);

    return Response.json({ personas, limits });
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

    // userId は入力からではなくセッションから取る
    const persona = await createPersonaForUser(user.id, body);

    return Response.json({ persona }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
