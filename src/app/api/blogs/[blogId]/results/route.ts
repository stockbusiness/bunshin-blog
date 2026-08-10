import { z } from 'zod';
import { toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  listWeeklyResultsForUser,
  saveWeeklyResultForUser,
} from '@/modules/analytics';

/**
 * `GET|POST /api/blogs/[blogId]/results`（TASKS G-5、SPEC 6.1）
 *
 * 週次の成果を手で入れる。**受け付けるのは成果件数と報酬額だけ**
 * （完了条件）。他の指標は自動で集める（G-2・G-6）。
 *
 * **週は指定させない。** いま入力しているのは常に「今週」で、
 * 過去の週を書き換える経路を画面から作らない — 実験の記録なので、
 * あとから静かに変えられるようにしない。
 */

export const runtime = 'nodejs';

const schema = z.object({
  conversions: z.number(),
  revenueYen: z.number(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ blogId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const results = await listWeeklyResultsForUser({
      userId: user.id,
      blogId,
    });

    return Response.json({ results });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ blogId: string }> },
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const input = schema.parse(await request.json());

    const result = await saveWeeklyResultForUser(
      { userId: user.id, blogId },
      input,
    );

    return Response.json({
      weekStart: result.weekStart,
      conversions: result.conversions,
      revenueYen: result.revenueYen,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
