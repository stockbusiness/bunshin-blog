/**
 * STEP 3 収益記事の設計の入口（TASKS E-6、SPEC 9.2.4）。
 *
 * ## AIが要る
 *
 * STEP 1・2 と違い、**AIを呼べないと成立しない。** タイトルと検索意図は
 * AIが作る文言そのもので、コードで代わりを作ることができない。
 * 呼べなければ失敗させる — **空のタイトルで構成表を作らない。**
 *
 * ただし**種類と本数はコードが決める**（CONTENT_PLANNING 4.1）。AIは
 * 渡した枠に文言を付けるだけで、枠を増減させられない。
 */

import type { AiProvider } from '@/lib/ai';
import { requireBlogForUser } from '@/modules/blogs';
import { listOffersForUser } from '@/modules/affiliate';
import { createConfiguredAiProvider } from '@/modules/settings';
import { writeRevenueTitles } from './ai';
import { invalidStep3InputError } from './errors';
import {
  createPlanWithItemsForUser,
  type AppContentItem,
  type NewContentItem,
} from './plan-repository';
import {
  matchRevenueTitles,
  planRevenueSlots,
  revenueArticleCount,
  type AdoptedOffer,
  type PlannedRevenueItem,
} from './step3';

export interface DesignRevenueArticlesInput {
  userId: string;
  blogId: string;
  /** STEP 2 が採用した案件のID。**順序は採点順** */
  adoptedOfferIds: readonly string[];
}

export interface DesignRevenueArticlesDeps {
  provider?: AiProvider | undefined;
}

export interface DesignRevenueArticlesResult {
  planId: string;
  version: number;
  items: AppContentItem[];
  /** SPEC 9.2.4 の式で出した本数。実際の件数と一致する */
  expectedCount: number;
}

/** 収益記事の型を `content_items` の種別へ写す */
function toContentType(pattern: PlannedRevenueItem['pattern']) {
  return pattern === 'COMPARISON'
    ? ('COMPARISON' as const)
    : ('AFFILIATE' as const);
}

/**
 * 採用案件から収益記事を設計する（完了条件「記事数が『案件数×2＋1』で
 * 算出される」）。
 *
 * @throws {AppError} ブログが自分のものでない・採用案件が無い・
 *   AIの出力が枠と合わない
 */
export async function designRevenueArticlesForUser(
  input: DesignRevenueArticlesInput,
  deps: DesignRevenueArticlesDeps = {},
): Promise<DesignRevenueArticlesResult> {
  const blog = await requireBlogForUser(input);

  const offers = await listOffersForUser({
    userId: input.userId,
    blogId: input.blogId,
  });

  const byId = new Map(offers.map((offer) => [offer.id, offer]));
  const adopted: AdoptedOffer[] = [];

  for (const offerId of input.adoptedOfferIds) {
    const offer = byId.get(offerId);

    // **このブログの案件でなければ落とす。** 渡されたIDをそのまま
    // 使うと、他人の案件で構成表を作れる（C-6 と同じ形）
    if (offer === undefined) {
      throw invalidStep3InputError(
        '採用された案件がこのブログにありません。STEP 2 をやり直してください',
      );
    }

    adopted.push({
      offerId: offer.id,
      offerName: offer.name,
      facts: offer.facts,
    });
  }

  const slots = planRevenueSlots(adopted);
  const provider = deps.provider ?? (await createConfiguredAiProvider());

  const titles = await writeRevenueTitles({
    provider,
    penName: blog.penName,
    targetReader: blog.targetReader,
    slots,
  });

  // **枠との一致を確かめてから保存する**（CONTENT_PLANNING 4.2）
  const planned = matchRevenueTitles(slots, titles);

  const items: NewContentItem[] = planned.map((item, index) => ({
    sequenceNo: index + 1,
    contentType: toContentType(item.pattern),
    title: item.title,
    primaryKeyword: item.primaryKeyword,
    searchIntent: item.searchIntent,
    objective: 'REVENUE',
    affiliateOfferId: item.offerId,
    // **暫定。** 公開順序は E-9 が付け直す（SPEC 9.2 の最後の段）
    publishPriority: index + 1,
  }));

  const created = await createPlanWithItemsForUser({
    userId: input.userId,
    blogId: input.blogId,
    planType: 'INITIAL',
    strategySnapshot: {
      step: 'STEP3',
      adoptedOfferIds: [...input.adoptedOfferIds],
      revenueCount: items.length,
    },
    items,
  });

  return {
    ...created,
    expectedCount: revenueArticleCount(adopted.length),
  };
}
