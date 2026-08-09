/**
 * 記事生成の入口（TASKS E-10、SPEC 9.5、CONTENT_PLANNING 7）。
 *
 * ## 構成表を経由しない生成を作らない
 *
 * 完了条件が「**構成表を参照して生成。単体生成モードを作らない**」。
 * 入口は `contentItemId` を要求し、それが自分のブログの構成表にある
 * ことを確かめる。**タイトルを渡して1本作る関数は置かない** — 置くと、
 * 内部リンクも公開順序も持たない孤立した記事が生まれる。
 *
 * ## 内部リンクは構成表から取る
 *
 * 本文に書けるリンクは `outbound_link_item_ids` が指す記事と、
 * その記事のアフィリエイトリンクだけ。**AIに選ばせない。**
 *
 * ## プロンプトに書いた制約を受信後に確かめる
 *
 * CONTENT_PLANNING 7.2。**書いただけでは守られない。**
 */

import type { AiProvider } from '@/lib/ai';
import { requireBlogForUser } from '@/modules/blogs';
import {
  buildAffiliateLink,
  ensureRedirectLinkForUser,
  readLinkableOfferForUser,
} from '@/modules/affiliate';
import {
  listPersonaFactsForUser,
  resolveEffectivePersonaForUser,
} from '@/modules/personas';
import { createConfiguredAiProvider } from '@/modules/settings';
import { recordAiUsageAndNotify } from '@/modules/ai-costs';
import { generateArticle, type ArticleGenerationInput } from './ai';
import {
  articleContentHash,
  assertAllowedLinks,
  assertPrDisclosure,
  assertUsedFacts,
} from './article';
import {
  listSiblingItemsForUser,
  requirePlannedItemForUser,
  saveArticleVersion,
  type AppArticleVersion,
} from './article-repository';
import { requireActivePrompt } from './repository';
import { GENERATION_PROMPT_KEYS } from './ai';

export interface GenerateArticleForUserInput {
  userId: string;
  blogId: string;
  /** **構成表にある記事のID。** 単体生成の入口は無い */
  contentItemId: string;
}

export interface GenerateArticleDeps {
  provider?: AiProvider | undefined;
}

/**
 * 記事を生成して保存する。
 *
 * @throws {AppError} 構成表に無い・検査を通らない・AIが応答しない
 */
export async function generateArticleForUser(
  input: GenerateArticleForUserInput,
  deps: GenerateArticleDeps = {},
): Promise<AppArticleVersion> {
  const blog = await requireBlogForUser(input);

  const item = await requirePlannedItemForUser(input);
  const prompt = await requireActivePrompt(GENERATION_PROMPT_KEYS.article);

  const [persona, facts, siblings] = await Promise.all([
    resolveEffectivePersonaForUser({
      userId: input.userId,
      blogId: input.blogId,
    }),
    listPersonaFactsForUser(input.userId, {
      blogId: input.blogId,
      usableFirstPersonOnly: false,
    }),
    listSiblingItemsForUser(input),
  ]);

  const byId = new Map(siblings.map((sibling) => [sibling.id, sibling]));

  // **内部リンクは構成表から取る。** AIに選ばせない
  const internalLinks = item.outboundLinkItemIds
    .map((id) => byId.get(id))
    .filter(
      (sibling): sibling is NonNullable<typeof sibling> =>
        sibling !== undefined,
    )
    .map((sibling) => ({
      itemId: sibling.id,
      title: sibling.title,
      // Phase 0 は WordPress の投稿URLが投稿後に決まるため、
      // **記事内では相対の目印を使う**（本文へ埋めるのは F-7 の投稿時）
      url: `#item-${sibling.id}`,
    }));

  const offer =
    item.affiliateOfferId === null
      ? null
      : await readLinkableOfferForUser({
          userId: input.userId,
          blogId: input.blogId,
          offerId: item.affiliateOfferId,
        });

  // **`REDIRECT` の案件は先にコードを発行する**（D-8）。ここで
  // `affiliate_links` に行ができ、記事と案件が同じブログであることは
  // 複合外部キーがDB側で確かめる（D-11）
  const redirectCode =
    offer !== null && offer.linkMode === 'REDIRECT'
      ? (
          await ensureRedirectLinkForUser({
            userId: input.userId,
            blogId: input.blogId,
            offerId: offer.id,
            contentItemId: item.id,
            slotNumber: blog.slotNumber,
          })
        ).code
      : undefined;

  const affiliateHref =
    offer === null
      ? null
      : buildAffiliateLink({
          offer,
          slotNumber: blog.slotNumber,
          contentItemId: item.id,
          ...(redirectCode === undefined ? {} : { redirectCode }),
        }).href;

  const generationInput: ArticleGenerationInput = {
    contentItem: {
      title: item.title,
      primaryKeyword: item.primaryKeyword,
      searchIntent: item.searchIntent,
      contentType: item.contentType,
    },
    persona: {
      penName: persona.penName,
      tone: persona.tone,
      writingRules: persona.writingRules,
      ngExpressions: persona.ngExpressions,
    },
    usableFacts: facts.map((fact) => ({
      factId: fact.id,
      content: fact.content,
      usableFirstPerson: fact.usableFirstPerson,
    })),
    offer:
      offer === null
        ? null
        : {
            name: item.title,
            facts: {},
            affiliateUrl: affiliateHref ?? offer.affiliateUrl,
          },
    internalLinks,
    existingTitles: siblings.map((sibling) => sibling.title),
  };

  const generated = await generateArticle({
    provider: deps.provider ?? (await createConfiguredAiProvider()),
    input: generationInput,
    systemPrompt: prompt.body,
  });

  // **プロンプトに書いた制約を受信後に確かめる**（CONTENT_PLANNING 7.2）
  assertAllowedLinks({
    bodyHtml: generated.article.bodyHtml,
    allowedUrls: [
      ...internalLinks.map((link) => link.url),
      ...(affiliateHref === null ? [] : [affiliateHref]),
    ],
  });

  assertPrDisclosure({
    bodyHtml: generated.article.bodyHtml,
    hasAffiliateLink: affiliateHref !== null,
  });

  assertUsedFacts({
    usedFactIds: generated.article.usedFactIds,
    availableFactIds: facts.map((fact) => fact.id),
  });

  const saved = await saveArticleVersion({
    contentItemId: item.id,
    title: generated.article.title,
    excerpt: generated.article.excerpt,
    answerCapsule: generated.article.answerCapsule,
    bodyHtml: generated.article.bodyHtml,
    faq: generated.article.faq,
    usedFactIds: generated.article.usedFactIds,
    claims: generated.article.claims,
    contentHash: articleContentHash({
      title: generated.article.title,
      bodyHtml: generated.article.bodyHtml,
    }),
    modelProvider: generated.provider,
    modelName: generated.model,
    promptVersion: prompt.version,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    costUsd: generated.costUsd,
  });

  // **費用は必ず記録する**（E-14）。予算の通知もここで判定される（E-15）
  await recordAiUsageAndNotify({
    userId: input.userId,
    blogId: input.blogId,
    contentItemId: item.id,
    provider: generated.provider,
    model: generated.model,
    operation: GENERATION_PROMPT_KEYS.article,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    ...(generated.costUsd === null ? {} : { costUsd: generated.costUsd }),
  });

  return saved;
}
