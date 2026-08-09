/**
 * 記事生成のAI呼び出し（TASKS E-10、CONTENT_PLANNING 7.1）。
 *
 * **JSONだけを返させ、必ず検証する**（CONTENT_PLANNING 1.2）。失敗したら
 * 1回だけやり直し、それでも駄目ならジョブを失敗させる。
 *
 * **プロンプトに書いた制約を信じない。** 検査そのものは `article.ts` に
 * 置き、ここからは**やり直しで直りうるもの**（アンサーカプセルの文字数、
 * FAQ の形）だけをループの中で呼ぶ。構成表と突き合わせる検査は
 * `generate.ts` — 作り直しても結果が変わらないため。
 */

import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { AppError } from '@/lib/errors';
import { assertAnswerCapsule, assertFaq } from './article';
import { invalidArticleError } from './errors';

/** プロンプトのキー（CONTENT_PLANNING 1.4 で固定） */
export const GENERATION_PROMPT_KEYS = {
  article: 'generation.article',
  claimExtraction: 'generation.claim_extraction',
} as const;

const articleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(240),
  answerCapsule: z.string().trim().min(1).max(400),
  bodyHtml: z.string().trim().min(1),
  faq: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(200),
        answer: z.string().trim().min(1).max(1_000),
      }),
    )
    .default([]),
  usedFactIds: z.array(z.string().trim().min(1)).default([]),
  claims: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        source: z.enum(['offer_facts', 'persona_facts', 'general']),
      }),
    )
    .default([]),
});

export type GeneratedArticle = z.infer<typeof articleSchema>;

export interface ArticleGenerationInput {
  contentItem: {
    title: string;
    primaryKeyword: string | null;
    searchIntent: string;
    contentType: string;
  };
  persona: {
    penName: string | null;
    tone: unknown;
    writingRules: unknown;
    ngExpressions: readonly string[];
  };
  usableFacts: readonly {
    factId: string;
    content: string;
    usableFirstPerson: boolean;
  }[];
  offer: {
    name: string;
    facts: unknown;
    affiliateUrl: string;
  } | null;
  internalLinks: readonly { itemId: string; title: string; url: string }[];
  existingTitles: readonly string[];
}

export interface ArticleGenerationAttempt {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface GenerateArticleResult extends ArticleGenerationAttempt {
  article: GeneratedArticle;
}

const JSON_ONLY =
  'JSONだけを返してください。前置き・後書き・コードフェンスを付けないでください。';

function stripFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * 記事の種別から用途（＝モデルの段）を決める。
 *
 * **収益記事は HIGH**（CONTENT_PLANNING 1.3「収益記事の本文」）。
 * 集客記事は STANDARD。**呼び出し側にモデル名を書かせない**（E-3）。
 */
export function operationForContentType(contentType: string): AiOperation {
  if (contentType === 'AFFILIATE') {
    return 'PRIORITY_ARTICLE';
  }

  if (contentType === 'COMPARISON') {
    return 'COMPARISON';
  }

  return 'ARTICLE_BODY';
}

/**
 * 記事を生成する。
 *
 * **1回だけやり直す**（CONTENT_PLANNING 1.2）。壊れた出力を繰り返し
 * 引かせても直らず、費用だけが増える。
 *
 * ## やり直しの対象
 *
 * JSONとして読めない場合に加えて、**アンサーカプセルの文字数と FAQ の形**
 * が範囲外なら作り直す（CONTENT_PLANNING 7.2「コードで文字数を検査。
 * 範囲外なら再生成」）。長さの違反は次の試行で直りうるので、
 * 1回目で落とさない。
 *
 * ## 失敗した試行にも費用がかかる
 *
 * `onAttempt` は**検証の前に**、試行ごとに呼ぶ。
 * 「再生成ループの各試行も個別に記録する」（CONTENT_PLANNING 9）ため、
 * 最終的に失敗した試行の費用も記録から漏らさない。
 */
export async function generateArticle(params: {
  provider: AiProvider;
  input: ArticleGenerationInput;
  systemPrompt: string;
  maxOutputTokens?: number | undefined;
  onAttempt?:
    ((attempt: ArticleGenerationAttempt) => Promise<void>) | undefined;
}): Promise<GenerateArticleResult> {
  const operation = operationForContentType(
    params.input.contentItem.contentType,
  );

  let lastCheckFailure: AppError | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await params.provider.complete({
      operation,
      system: `${params.systemPrompt}\n\n${JSON_ONLY}`,
      messages: [{ role: 'user', content: JSON.stringify(params.input) }],
      maxOutputTokens: params.maxOutputTokens ?? 8_000,
      temperature: 0.7,
    });

    // **検証より先に記録する。** 落ちる応答にも費用は発生している
    await params.onAttempt?.({
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    });

    try {
      const article = articleSchema.parse(JSON.parse(stripFence(result.text)));

      // **形の検査はここで行う**（CONTENT_PLANNING 7.2）。範囲外なら再生成
      assertAnswerCapsule(article.answerCapsule);
      assertFaq(article.faq);

      return {
        article,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      };
    } catch (error) {
      // **応答本文を持ち回らない**（SPEC 14.2）。自分で投げた検査の
      // 結果だけは残す — 何度作り直しても直らないときの手がかりになる
      if (error instanceof AppError) {
        lastCheckFailure = error;
      }
    }
  }

  throw lastCheckFailure ?? invalidArticleError('AIの応答を読めませんでした');
}
