/**
 * STEP 1 のAI呼び出し（TASKS E-4、CONTENT_PLANNING 2.2・2.3）。
 *
 * ## AIは判定しない
 *
 * `planning.step1.genre_review` は**判定結果を言い換えるだけ**。
 * `decision` は入力として渡し、AIに再判定させない（CONTENT_PLANNING 2.2）。
 * 戻り値に `decision` を含めないのは、**含められる形にすると
 * いつか使われる**ため。
 *
 * ## JSONだけを返させ、必ず検証する
 *
 * > 全プロンプトはJSONのみを返させる。受信側は必ずZodスキーマで検証する。
 * > 検証に失敗したら**1回だけ再試行**し、それでも失敗ならジョブを `FAILED`
 * > にする（CONTENT_PLANNING 1.2）
 *
 * 再試行を1回に留めるのは、**壊れた出力を繰り返し引かせても直らない**ため。
 * プロンプトかモデルの問題で、費用だけが増える。
 *
 * ## 候補の除外はコードで行う
 *
 * `alternative_genres` の結果から `HIGH` と既に停止したジャンルを外すのは
 * **受信後のコードの仕事**（CONTENT_PLANNING 2.3）。AIに「除いてください」と
 * 書いて信じない。
 */

import { z } from 'zod';
import type { AiProvider } from '@/lib/ai';
import { invalidAiResponseError } from './errors';
import type { GenreCandidate, Step1Decision } from './step1';

/** プロンプトのキー。CONTENT_PLANNING 1.4 で固定されている */
export const STEP1_PROMPT_KEYS = {
  genreReview: 'planning.step1.genre_review',
  alternativeGenres: 'planning.step1.alternative_genres',
} as const;

/** 案出し系は 0.7、抽出・分類系は 0.0（CONTENT_PLANNING 1.2） */
const TEMPERATURE_SUGGESTION = 0.7;
const TEMPERATURE_RESTATEMENT = 0.0;

/** 差し戻し時に出す候補の件数（CONTENT_PLANNING 2.3） */
export const ALTERNATIVE_GENRE_COUNT = 3;

const genreReviewSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  cautions: z.array(z.string().trim().min(1)).max(3).default([]),
});

const alternativeGenresSchema = z.object({
  candidates: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        reason: z.string().trim().min(1).max(160),
        expectedYmylRisk: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      }),
    )
    .default([]),
});

export type GenreReviewText = z.infer<typeof genreReviewSchema>;
export type AlternativeGenre = GenreCandidate;

/**
 * JSONだけを返させるための共通指示。
 *
 * **前置きもコードフェンスも禁じる**（CONTENT_PLANNING 1.2）。
 */
const JSON_ONLY =
  'JSONだけを返してください。前置き・後書き・コードフェンスを付けないでください。';

/**
 * コードフェンスが付いてきた場合に剥がす。
 *
 * **禁じてあるが、来たものは読む。** 指示に従わなかっただけで
 * 内容が正しいことは多く、1回の再試行を無駄にしない。
 */
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
 * AIを呼び、JSONとして検証する。**失敗したら1回だけやり直す。**
 */
async function completeJson<T>(params: {
  provider: AiProvider;
  key: string;
  operation: 'GENRE_SUGGESTION' | 'GENRE_REVIEW';
  system: string;
  input: unknown;
  temperature: number;
  maxOutputTokens: number;
  schema: z.ZodType<T>;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await params.provider.complete({
      operation: params.operation,
      system: `${params.system}\n\n${JSON_ONLY}`,
      messages: [{ role: 'user', content: JSON.stringify(params.input) }],
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
    });

    try {
      return params.schema.parse(JSON.parse(stripFence(result.text)));
    } catch {
      // **元の例外を持ち回らない。** 応答本文が混ざりうる（SPEC 14.2）
    }
  }

  throw invalidAiResponseError(params.key);
}

/**
 * 判定結果を利用者に伝える文章を作る。
 *
 * **`decision` は入力。** AIに決めさせない（CONTENT_PLANNING 2.2）。
 */
export async function describeGenreReview(params: {
  provider: AiProvider;
  genreName: string;
  decision: Step1Decision;
  reasons: readonly string[];
  userHasExperience: boolean;
}): Promise<GenreReviewText> {
  return completeJson({
    provider: params.provider,
    key: STEP1_PROMPT_KEYS.genreReview,
    // 所見は HIGH（CONTENT_PLANNING 1.3「ジャンル審査の所見」）
    operation: 'GENRE_REVIEW',
    system: [
      'あなたはアフィリエイトブログの編集長です。',
      'ジャンル審査の判定結果を、利用者に分かる言葉で説明してください。',
      '**判定をやり直さないでください。** 渡された decision の理由を言い換えるだけです。',
      'summary は120字以内、cautions は最大3件です。',
    ].join('\n'),
    input: {
      genreName: params.genreName,
      decision: params.decision,
      reasons: [...params.reasons],
      userHasExperience: params.userHasExperience,
    },
    temperature: TEMPERATURE_RESTATEMENT,
    maxOutputTokens: 600,
    schema: genreReviewSchema,
  });
}

/**
 * 別のジャンルの候補を出す（`BLOCKED` のときだけ）。
 *
 * **受け取った候補はそのまま使わない。** `filterAlternatives` を通す。
 */
export async function suggestAlternativeGenres(params: {
  provider: AiProvider;
  genreName: string;
  blockedReasons: readonly string[];
  experiences: readonly string[];
}): Promise<AlternativeGenre[]> {
  const result = await completeJson({
    provider: params.provider,
    key: STEP1_PROMPT_KEYS.alternativeGenres,
    // 案出しは STANDARD（CONTENT_PLANNING 1.3「キーワード案」と同じ扱い）
    operation: 'GENRE_SUGGESTION',
    system: [
      'あなたはアフィリエイトブログの編集長です。',
      `隣接するジャンルの候補を${ALTERNATIVE_GENRE_COUNT}件挙げてください。`,
      'reason は80字以内です。',
      'expectedYmylRisk は HIGH / MEDIUM / LOW のいずれかです。',
    ].join('\n'),
    input: {
      genreName: params.genreName,
      blockedReasons: [...params.blockedReasons],
      userProfile: { experiences: [...params.experiences] },
    },
    temperature: TEMPERATURE_SUGGESTION,
    maxOutputTokens: 800,
    schema: alternativeGenresSchema,
  });

  return result.candidates;
}
