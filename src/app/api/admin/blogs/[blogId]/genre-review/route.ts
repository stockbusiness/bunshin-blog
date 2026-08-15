import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { assignGenreForAdmin, listBlogsForAdmin } from '@/modules/blogs';
import { reviewGenreForUser } from '@/modules/content-planning';

/**
 * `POST /api/admin/blogs/:blogId/genre-review`（Q-049、E-4、SPEC 9.2.2）
 *
 * ジャンル審査を回し、**通ったらブログへ割り当てる。** ADMIN だけ。
 *
 * ## なぜ ADMIN が回すのか
 *
 * 判定には**検索上位10件の内訳**が要る（`judgeGenre` は空を拒む）。
 * **取得する仕組みがどこにも無い**ので、SPEC 9.2.2 のフォールバック
 * 「取得できない場合はADMINの手動入力値を使う」を正面から使う（Q-049）。
 *
 * ## 審査と割り当てをここで繋ぐ
 *
 * **`content-planning` は判定と記録を持ち、`blogs` は書き込みを持つ。**
 * 順に呼ぶのは上位の仕事（MODULE_RULES 3「上位へ寄せる」）。
 * `blogs` から `content-planning` を呼ぶと依存が逆向きになる。
 *
 * ## 通らなかったら割り当てない
 *
 * `BLOCKED` のときは**ジャンルを付けない。** 付けてしまうと、
 * **停止条件を満たすジャンルでブログが動き出す** — E-4 の完了条件
 * 「停止条件を満たすジャンルが通過しない」がそこで壊れる。
 *
 * `WARNED` は付ける。**警告は「進めるが利用者に明示する」**（SPEC 9.2.2）。
 */

export const runtime = 'nodejs';

const DOMAIN_TYPES = [
  'official',
  'major_comparison',
  'personal',
  'other',
] as const;

const schema = z.object({
  genreId: z.string().uuid(),
  /**
   * 検索上位の内訳。**空では審査できない**（`judgeGenre` が拒む）。
   * 取得できないことを理由に停止条件を飛ばさない（CONTENT_PLANNING 2.1）
   */
  serpTop10: z
    .array(z.object({ domainType: z.enum(DOMAIN_TYPES) }))
    .min(1)
    .max(10),
  userHasExperience: z.boolean(),
});

type Context = { params: Promise<{ blogId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));
    const { blogId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('審査の入力を確認してください');
    }

    // **持ち主は入力から取らない。** ADMIN が別人のIDを渡せてしまうと、
    // **他人のブログの審査履歴に記録が積まれる**（差し戻し回数は
    // 履歴から数えるので、回数が狂う）
    const blog = (await listBlogsForAdmin()).find(
      (candidate) => candidate.id === blogId,
    );

    if (blog === undefined) {
      throw AppError.notFound('ブログが見つかりません');
    }

    const result = await reviewGenreForUser({
      userId: blog.userId,
      blogId: blog.id,
      genreId: parsed.data.genreId,
      serpTop10: parsed.data.serpTop10,
      userHasExperience: parsed.data.userHasExperience,
    });

    // **`BLOCKED` は割り当てない。** 付けると、停止条件を満たす
    // ジャンルでブログが動き出す
    const assigned =
      result.judgement.decision === 'BLOCKED'
        ? null
        : await assignGenreForAdmin({
            blogId: blog.id,
            genreId: parsed.data.genreId,
          });

    return Response.json({
      decision: result.judgement.decision,
      reasons: result.judgement.reasons,
      serpBreakdown: result.judgement.serpBreakdown,
      canOverride: result.canOverride,
      text: result.text,
      alternatives: result.alternatives,
      // 付いたジャンル。`BLOCKED` なら `null`
      genre: assigned?.genre ?? null,
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
