/**
 * 事実チェックの実行（TASKS E-12、CONTENT_PLANNING 8、SPEC 9.7）。
 *
 * ## 生成した記事は必ずここを通る
 *
 * 完了条件は「facts外の数値・条件を検出。**FAILEDは承認依頼へ送らない**」。
 * `generateArticleForUser` から呼び、**チェックを飛ばす経路を作らない**。
 * 別の入口として置くと、「呼び忘れた記事」が `NOT_CHECKED` のまま残り、
 * それが承認画面で「問題なし」に見える。
 */

import type { AiProvider } from '@/lib/ai';
import { requireBlogForUser } from '@/modules/blogs';
import { readLinkableOfferForUser } from '@/modules/affiliate';
import { listPersonaFactsForUser } from '@/modules/personas';
import { createConfiguredAiProvider } from '@/modules/settings';
import { recordAiUsageAndNotify } from '@/modules/ai-costs';
import { GENERATION_PROMPT_KEYS } from './ai';
import { extractClaims } from './claim-extraction';
import {
  areFactsStale,
  judgeFactCheck,
  verifyClaims,
  type FactCheckStatus,
  type UnverifiedClaim,
} from './fact-check';
import {
  findLatestArticleVersion,
  requirePlannedItemForUser,
  saveFactCheckResult,
  type AppArticleVersion,
} from './article-repository';
import { requireActivePrompt } from './repository';
import { itemNotInPlanError } from './errors';

export interface FactCheckArticleInput {
  userId: string;
  blogId: string;
  contentItemId: string;
  /** 省略したら最新の版を見る */
  articleVersionId?: string | undefined;
}

export interface FactCheckArticleDeps {
  provider?: AiProvider | undefined;
  /** 試験のために差し替える。既定は現在時刻 */
  now?: Date | undefined;
}

export interface FactCheckArticleResult {
  version: AppArticleVersion;
  status: FactCheckStatus;
  unverified: UnverifiedClaim[];
}

/**
 * 記事の事実チェックを行い、結果を保存する。
 *
 * @throws {AppError} 自分の記事でない・版が無い・抽出に失敗した
 */
export async function factCheckArticleForUser(
  input: FactCheckArticleInput,
  deps: FactCheckArticleDeps = {},
): Promise<FactCheckArticleResult> {
  await requireBlogForUser(input);

  const item = await requirePlannedItemForUser(input);
  const latest = await findLatestArticleVersion(item.id);

  if (latest === null) {
    throw itemNotInPlanError();
  }

  // **版を指定されたら、その記事の版であることを確かめる**（C-6 と同じ形）
  if (
    input.articleVersionId !== undefined &&
    input.articleVersionId !== latest.id
  ) {
    throw itemNotInPlanError();
  }

  const prompt = await requireActivePrompt(
    GENERATION_PROMPT_KEYS.claimExtraction,
  );

  const [offer, personaFacts] = await Promise.all([
    item.affiliateOfferId === null
      ? null
      : readLinkableOfferForUser({
          userId: input.userId,
          blogId: input.blogId,
          offerId: item.affiliateOfferId,
        }),
    // **一人称で使ってよいものだけを照合先にする**（CONTENT_PLANNING 8.2）。
    // 使ってはいけない事実を根拠に体験談を通したら、D-6 の制限が無意味になる
    listPersonaFactsForUser(input.userId, {
      blogId: input.blogId,
      usableFirstPersonOnly: true,
    }),
  ]);

  const extracted = await extractClaims({
    provider: deps.provider ?? (await createConfiguredAiProvider()),
    bodyHtml: latest.bodyHtml,
    systemPrompt: prompt.body,
    onAttempt: async (attempt) => {
      await recordAiUsageAndNotify({
        userId: input.userId,
        blogId: input.blogId,
        contentItemId: item.id,
        provider: attempt.provider,
        model: attempt.model,
        operation: GENERATION_PROMPT_KEYS.claimExtraction,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        ...(attempt.costUsd === null ? {} : { costUsd: attempt.costUsd }),
      });
    },
  });

  // **照合はコードで行う**（CONTENT_PLANNING 8.1）
  const unverified = verifyClaims({
    claims: extracted.claims,
    offerFacts: offer?.facts ?? null,
    usablePersonaFacts: personaFacts.map((fact) => fact.content),
  });

  const status = judgeFactCheck({
    unverified,
    factsAreStale:
      offer !== null &&
      areFactsStale({
        factsUpdatedAt: offer.factsUpdatedAt,
        now: deps.now ?? new Date(),
      }),
  });

  const version = await saveFactCheckResult({
    contentItemId: item.id,
    articleVersionId: latest.id,
    status,
    unverifiedClaims: unverified,
  });

  return { version, status, unverified };
}
