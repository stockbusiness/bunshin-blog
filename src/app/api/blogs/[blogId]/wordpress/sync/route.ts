import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import { syncWordpressPostForUser } from '@/modules/wordpress';

/**
 * `POST /api/blogs/:blogId/wordpress/sync`（SPEC 13.3、TASKS I-3）
 *
 * **C-5 で同期処理は作ったが、HTTPの入口が無かった**（棚卸し・2026-08-12）。
 *
 * ## 記事を1本ずつ指定する
 *
 * SPEC 13.3 は `/sync` としか書いていないが、**ブログまるごとの同期に
 * しない。** 30記事ぶんの WordPress 呼び出しが1リクエストに入ると、
 * 関数の実行時間の上限を超えて**途中で切れたことに気づけない。**
 *
 * まとめて同期したくなったら `WORDPRESS_SYNC` ジョブを積む形にする
 * （ジョブの種類は E-1 で定義済み。積む経路は未実装）。
 *
 * 他人のブログ・他ブログの記事は **404**（B-3 の方針）。
 */

export const runtime = 'nodejs';

const syncSchema = z.object({
  contentItemId: z.string().uuid(),
});

type Context = { params: Promise<{ blogId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = syncSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.badRequest('contentItemId が必要です');
    }

    const post = await syncWordpressPostForUser({
      userId: user.id,
      blogId,
      contentItemId: parsed.data.contentItemId,
    });

    return Response.json({ post });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
