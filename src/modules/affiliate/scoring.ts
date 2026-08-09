/**
 * STEP 2 の採点結果の保存（TASKS E-5、SPEC 9.2.3）。
 *
 * **`affiliate_offers` は `affiliate` の所有テーブル**（MODULE_RULES 1）。
 * 採点そのものは `content-planning` が行い、書き込みはここを経由する。
 *
 * **点数の計算はここでしない。** 受け取った値を保存するだけ。
 * 判定を2か所に持つと、いつかずれる。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireBlogForUser } from '@/modules/blogs';

export interface OfferScoreInput {
  offerId: string;
  /** 0〜100。`content-planning` が計算した合計 */
  score: number;
  /** 内訳（DATA_MODEL 3章 `score_breakdown`） */
  breakdown: Prisma.InputJsonValue;
}

/**
 * 採点結果をまとめて保存する。
 *
 * **自分のブログの案件だけを更新する。** `offerId` は呼び出し側から
 * 渡ってくるため、`blog_id` を条件に必ず含める（C-6 と同じ形の穴を
 * 作らない）。
 *
 * @returns 実際に更新した件数
 */
export async function saveOfferScoresForUser(
  params: { userId: string; blogId: string },
  scores: readonly OfferScoreInput[],
): Promise<number> {
  const blog = await requireBlogForUser(params);

  let updated = 0;

  for (const entry of scores) {
    const result = await prisma.affiliateOffer.updateMany({
      // **`blogId` を必ず条件に入れる。** `offerId` だけで更新すると、
      // 他人の案件の点数を書き換えられる
      where: { id: entry.offerId, blogId: blog.id },
      data: {
        selectionScore: entry.score,
        scoreBreakdown: entry.breakdown,
      },
    });

    updated += result.count;
  }

  return updated;
}
