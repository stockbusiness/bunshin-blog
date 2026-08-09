/**
 * 事実主張の抽出（TASKS E-12、CONTENT_PLANNING 8.1）。
 *
 * ## AIには「何を主張しているか」だけを訊く
 *
 * > 本文から事実主張を抽出させる**だけ**。**照合はコードで行う。**
 *
 * 「この主張は正しいですか」と訊かない。訊けば「正しいです」と返ってきて、
 * **確かめたことにならない**。判定は `fact-check.ts`。
 *
 * 用途は `FACT_CLAIM_EXTRACT`（LOW段）。抽出は判断を含まないため、
 * 高い段のモデルを使う理由が無い。
 */

import { z } from 'zod';
import type { AiProvider } from '@/lib/ai';
import { CLAIM_TYPES, type ExtractedClaim } from './fact-check';
import { invalidArticleError } from './errors';

const claimsSchema = z.object({
  claims: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(500),
        type: z.enum(CLAIM_TYPES),
        excerpt: z.string().trim().max(500).default(''),
      }),
    )
    .default([]),
});

export interface ExtractClaimsResult {
  claims: ExtractedClaim[];
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
 * 本文から事実主張を抽出する。
 *
 * **1回だけやり直す**（CONTENT_PLANNING 1.2）。
 *
 * **抽出に失敗したら記事を通さない。** 「主張が0件でした」と
 * 「抽出できませんでした」を同じ扱いにすると、**壊れた応答が
 * `PASSED` に化ける**。
 */
export async function extractClaims(params: {
  provider: AiProvider;
  bodyHtml: string;
  systemPrompt: string;
  onAttempt?:
    | ((attempt: {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number | null;
      }) => Promise<void>)
    | undefined;
}): Promise<ExtractClaimsResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await params.provider.complete({
      operation: 'FACT_CLAIM_EXTRACT',
      system: `${params.systemPrompt}\n\n${JSON_ONLY}`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ bodyHtml: params.bodyHtml }),
        },
      ],
      maxOutputTokens: 4_000,
      // **抽出は揺らさない。** 同じ本文から毎回違う主張が出ると、
      // 事実チェックの結果が再現しない
      temperature: 0,
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
      const parsed = claimsSchema.parse(JSON.parse(stripFence(result.text)));

      return {
        claims: parsed.claims,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      };
    } catch {
      // **元の例外を持ち回らない。** 記事本文が混ざりうる（SPEC 14.2）
    }
  }

  throw invalidArticleError('主張を抽出できませんでした');
}
