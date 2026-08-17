/**
 * モデルルーティング（TASKS E-3、SPEC 9.8）。
 *
 * **用途から段を決める。** 呼び出し側にモデル名を書かせない
 * （SPEC「モデル名をコードに直書きしない」）。
 *
 * 段を挟むのは、モデルを乗り換えたときに**直す場所を1つにする**ため。
 * 用途ごとに直接モデル名を持たせると、乗り換えのたびに全ての呼び出しを
 * 探すことになる。
 */

/** モデルの段（SPEC 9.8） */
export type ModelTier = 'LOW' | 'STANDARD' | 'HIGH';

export const MODEL_TIERS: readonly ModelTier[] = ['LOW', 'STANDARD', 'HIGH'];

/**
 * AIを使う場面（SPEC 9.8）。
 *
 * **`ai_usage_logs.operation` にそのまま入れる**ので、増やすときは
 * 集計（G-6・E-14）への影響を考えること。
 *
 * `GENRE_REVIEW` `GENRE_SUGGESTION` は **SPEC 9.8 の表に無い**（E-4 で追加。
 * OPEN_QUESTIONS Q-018）。CONTENT_PLANNING 1.3 が「ジャンル審査の所見」に
 * MODEL_HIGH を指定しているのに、対応する場面が9.8の一覧に無かった。
 * 既存の場面へ寄せると**費用の内訳が用途とずれる**ため、場面のほうを足した。
 */
export const AI_OPERATIONS = [
  // 低コストモデル
  'CLASSIFY',
  'SUMMARIZE',
  'NOTIFICATION_TEXT',
  'KEYWORD_DEDUP',
  'FACT_CLAIM_EXTRACT',
  // 標準モデル
  'GENRE_SUGGESTION',
  // 段4の下書き（Q-058・Q-047）。分類ではなく文章を書かせるので標準
  'PERSONA_DRAFT',
  'ARTICLE_BODY',
  'ARTICLE_REWRITE',
  'INTERNAL_LINK',
  'CTA',
  // 高性能モデル
  'GENRE_REVIEW',
  'PRIORITY_ARTICLE',
  'QUALITY_RECHECK',
  'COMPARISON',
  'MONTHLY_STRATEGY',
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

/**
 * 場面ごとの段（SPEC 9.8 の3つの一覧をそのまま写した）。
 *
 * **表を1か所に置く。** 判断が散ると、費用の見積もりが合わなくなる。
 */
const TIER_BY_OPERATION: Readonly<Record<AiOperation, ModelTier>> = {
  CLASSIFY: 'LOW',
  SUMMARIZE: 'LOW',
  NOTIFICATION_TEXT: 'LOW',
  KEYWORD_DEDUP: 'LOW',
  FACT_CLAIM_EXTRACT: 'LOW',

  GENRE_SUGGESTION: 'STANDARD',
  PERSONA_DRAFT: 'STANDARD',
  ARTICLE_BODY: 'STANDARD',
  ARTICLE_REWRITE: 'STANDARD',
  INTERNAL_LINK: 'STANDARD',
  CTA: 'STANDARD',

  GENRE_REVIEW: 'HIGH',
  PRIORITY_ARTICLE: 'HIGH',
  QUALITY_RECHECK: 'HIGH',
  COMPARISON: 'HIGH',
  MONTHLY_STRATEGY: 'HIGH',
};

export function isAiOperation(value: string): value is AiOperation {
  return (AI_OPERATIONS as readonly string[]).includes(value);
}

export function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/** 場面に対応する段を返す */
export function tierForOperation(operation: AiOperation): ModelTier {
  return TIER_BY_OPERATION[operation];
}

/** 段ごとの場面（設定画面や説明に使う） */
export function operationsForTier(tier: ModelTier): AiOperation[] {
  return AI_OPERATIONS.filter(
    (operation) => TIER_BY_OPERATION[operation] === tier,
  );
}
