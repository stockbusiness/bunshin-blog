import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { draftPersonaFromAnswers } from '@/modules/personas';
import { createConfiguredAiProvider } from '@/modules/settings';

/**
 * `POST /api/personas/draft`（Q-058、Q-047、段4）
 *
 * 3つの答えから、分身の残り20項目を**下書き**する。
 *
 * ## 保存しない
 *
 * **ここは作るだけ。** 返した下書きは画面に出て、
 * **人が直してから** `POST /api/personas` で保存される。
 *
 * ## 答えた3つは書き換えない
 *
 * `fields` と `exitCriteria` は本人の答えで上書きする（`draft.ts`）。
 * とくに**やめる条件をAIに書かせない** — 後から決めると
 * かけた時間に引きずられる、という仕掛けが無意味になる。
 */

export const runtime = 'nodejs';

const schema = z.object({
  fields: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
  audience: z.string().trim().min(1).max(300),
  exitCriteria: z.string().trim().min(1).max(500),
});

export async function POST(request: Request): Promise<Response> {
  try {
    await requireConsentedUser(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('3つの答えを確かめてください');
    }

    const provider = await createConfiguredAiProvider();
    const draft = await draftPersonaFromAnswers(parsed.data, { provider });

    return Response.json({ draft });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
