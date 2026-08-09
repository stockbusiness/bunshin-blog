/**
 * 記事生成のAI呼び出し（TASKS E-10、CONTENT_PLANNING 7.1）。
 *
 * **JSONだけを返させ、必ず検証する**（CONTENT_PLANNING 1.2）。失敗したら
 * 1回だけやり直し、それでも駄目ならジョブを失敗させる。
 *
 * **プロンプトに書いた制約を信じない。** 受信後の検査は `article.ts`。
 * ここは「送って受け取る」ところまで。
 */

import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { invalidArticleError } from './errors';

/** プロンプトのキー（CONTENT_PLANNING 1.4 で固定） */
export const GENERATION_PROMPT_KEYS = {
  article: 'generation.article',
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

export interface GenerateArticleResult {
  article: GeneratedArticle;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
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
 */
export async function generateArticle(params: {
  provider: AiProvider;
  input: ArticleGenerationInput;
  systemPrompt: string;
  maxOutputTokens?: number | undefined;
}): Promise<GenerateArticleResult> {
  const operation = operationForContentType(
    params.input.contentItem.contentType,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await params.provider.complete({
      operation,
      system: `${params.systemPrompt}\n\n${JSON_ONLY}`,
      messages: [{ role: 'user', content: JSON.stringify(params.input) }],
      maxOutputTokens: params.maxOutputTokens ?? 8_000,
      temperature: 0.7,
    });

    try {
      return {
        article: articleSchema.parse(JSON.parse(stripFence(result.text))),
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      };
    } catch {
      // **元の例外を持ち回らない。** 応答本文が混ざりうる（SPEC 14.2）
    }
  }

  throw invalidArticleError('AIの応答を読めませんでした');
}
