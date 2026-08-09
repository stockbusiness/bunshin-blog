/**
 * STEP 4 集客記事とリンク設計の入口（TASKS E-7、SPEC 9.2.5）。
 *
 * 手順は CONTENT_PLANNING 5.1 のとおり。
 *
 * ```
 * 1. 収益記事ごとに検索意図を3つ以上（AI）
 * 2. 検索意図をキーワードへ（AI）
 * 3. 重複を検出（コード）
 * 4. 重複だけ差し替え案を作らせる（AI）
 * 5. 保存 → リンクを割り当て（コード）
 * ```
 *
 * ## リンク先は `AFFILIATE` の記事だけ
 *
 * **保存の直前に必ず検査する**（完了条件）。手作業での検証では
 * 30本中9本でこの誤りが起きた（CONTENT_PLANNING 5.5）。
 *
 * **比較記事はリンク先にならない。** 収益記事ではあるが種別が
 * `COMPARISON` で、規則をそのまま適用する。
 */

import type { AiProvider } from '@/lib/ai';
import { requireBlogForUser } from '@/modules/blogs';
import { createConfiguredAiProvider } from '@/modules/settings';
import {
  repairKeywordConflicts,
  writeKeywords,
  writeSearchIntents,
} from './ai';
import { invalidStep4InputError, planNotFoundError } from './errors';
import {
  appendItemsToPlanForUser,
  listContentItemsForUser,
  saveLinksForUser,
  type AppContentItem,
} from './plan-repository';
import {
  INBOUND_LINK_MIN,
  applyKeywordRepairs,
  assertOutboundAreAffiliate,
  assignLinks,
  countInboundPerRevenue,
  findKeywordConflicts,
  type KeywordCandidate,
  type LinkableItem,
  type TrafficItemDraft,
} from './step4';

export interface DesignTrafficArticlesInput {
  userId: string;
  blogId: string;
  contentPlanId: string;
  genreName: string;
}

export interface DesignTrafficArticlesDeps {
  provider?: AiProvider | undefined;
}

export interface DesignTrafficArticlesResult {
  items: AppContentItem[];
  /** 収益記事ごとの被リンク数。3本未満は E-8 が扱う */
  inboundCounts: Record<string, number>;
  /** 3本に満たない収益記事のID */
  underLinked: string[];
}

/** `intentId` は「収益記事ID#連番」。**AIに作らせない**（照合できなくなる） */
function intentIdFor(revenueItemId: string, index: number): string {
  return `${revenueItemId}#${index}`;
}

export async function designTrafficArticlesForUser(
  input: DesignTrafficArticlesInput,
  deps: DesignTrafficArticlesDeps = {},
): Promise<DesignTrafficArticlesResult> {
  const blog = await requireBlogForUser(input);

  const existing = await listContentItemsForUser({
    userId: input.userId,
    blogId: input.blogId,
    contentPlanId: input.contentPlanId,
  });

  if (existing.length === 0) {
    throw planNotFoundError();
  }

  // **リンク先にできるのは `AFFILIATE` だけ**（比較記事は含めない）
  const revenueItems = existing.filter(
    (item) => item.contentType === 'AFFILIATE',
  );

  if (revenueItems.length === 0) {
    throw invalidStep4InputError(
      '収益記事がありません。STEP 3 をやり直してください',
    );
  }

  const provider = deps.provider ?? (await createConfiguredAiProvider());

  const intents = await writeSearchIntents({
    provider,
    genreName: input.genreName,
    targetReader: blog.targetReader,
    revenueItems: revenueItems.map((item) => ({
      itemId: item.id,
      title: item.title,
      pattern: item.affiliateOfferId === null ? 'COMPARISON' : 'REVIEW',
      offerName: item.title,
    })),
    perItem: INBOUND_LINK_MIN,
  });

  // **知らない収益記事IDを捨てる。** AIが作ったIDをそのまま使うと、
  // 他の記事や存在しないIDへリンクが向く
  const revenueIds = new Set(revenueItems.map((item) => item.id));
  const usable = intents.filter((intent) =>
    revenueIds.has(intent.revenueItemId),
  );

  if (usable.length === 0) {
    throw invalidStep4InputError('検索意図を作れませんでした');
  }

  const numbered = usable.map((intent, index) => ({
    intentId: intentIdFor(intent.revenueItemId, index),
    intent: intent.intent,
    readerState: intent.readerState,
    revenueItemId: intent.revenueItemId,
  }));

  const existingKeywords = existing
    .map((item) => item.primaryKeyword)
    .filter((keyword): keyword is string => keyword !== null);

  const keywords = await writeKeywords({
    provider,
    genreName: input.genreName,
    intents: numbered.map(({ intentId, intent, readerState }) => ({
      intentId,
      intent,
      readerState,
    })),
    existingKeywords,
  });

  const byIntentId = new Map(numbered.map((item) => [item.intentId, item]));
  const candidates: KeywordCandidate[] = keywords.filter((keyword) =>
    byIntentId.has(keyword.intentId),
  );

  // **重複はコードで見る。** `existingKeywords` を渡しても出る
  const conflicts = findKeywordConflicts(candidates, existingKeywords);

  const repairs =
    conflicts.length === 0
      ? []
      : await repairKeywordConflicts({
          provider,
          conflicts,
          existingKeywords,
        });

  const resolved = applyKeywordRepairs(candidates, repairs, existingKeywords);

  if (resolved.length === 0) {
    throw invalidStep4InputError('キーワードの重複を解消できませんでした');
  }

  const drafts: TrafficItemDraft[] = resolved.map((candidate) => {
    const source = byIntentId.get(candidate.intentId);

    if (source === undefined) {
      throw invalidStep4InputError(
        `検索意図 ${candidate.intentId} が見つかりません`,
      );
    }

    return {
      targetRevenueItemId: source.revenueItemId,
      title: candidate.title,
      primaryKeyword: candidate.primaryKeyword,
      searchIntent: source.intent,
      contentType: candidate.contentType,
    };
  });

  const created = await appendItemsToPlanForUser({
    userId: input.userId,
    blogId: input.blogId,
    contentPlanId: input.contentPlanId,
    items: drafts.map((draft) => ({
      contentType: draft.contentType,
      title: draft.title,
      primaryKeyword: draft.primaryKeyword,
      searchIntent: draft.searchIntent,
      objective: 'TRAFFIC' as const,
      affiliateOfferId: null,
      // **暫定。** 公開順序は E-9 が付け直す
      publishPriority: 0,
    })),
  });

  const assignment = assignLinks({
    drafts,
    trafficIds: created.map((item) => item.id),
  });

  const linkable: LinkableItem[] = [...existing, ...created].map((item) => ({
    id: item.id,
    contentType: item.contentType,
  }));

  const outbound = new Map<string, string[]>();

  for (const [index, ids] of assignment.outboundByTraffic) {
    const trafficId = created[index]?.id;

    if (trafficId === undefined) {
      throw invalidStep4InputError('集客記事の保存結果が足りません');
    }

    // **保存の直前に検査する**（完了条件。CONTENT_PLANNING 5.5）
    assertOutboundAreAffiliate(ids, linkable);
    outbound.set(trafficId, ids);
  }

  await saveLinksForUser({
    userId: input.userId,
    blogId: input.blogId,
    outbound,
    inbound: assignment.inboundByRevenue,
  });

  const counts = countInboundPerRevenue(linkable, assignment.inboundByRevenue);

  return {
    items: created,
    inboundCounts: Object.fromEntries(counts),
    underLinked: [...counts]
      .filter(([, count]) => count < INBOUND_LINK_MIN)
      .map(([itemId]) => itemId),
  };
}
