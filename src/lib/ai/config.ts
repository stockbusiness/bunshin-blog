/**
 * モデル名と料金の設定（TASKS E-3、SPEC 9.8）。
 *
 * > モデル名・料金は設定テーブルまたは環境変数で管理する（SPEC 9.8）
 *
 * **環境変数を採る。** 設定テーブルを足すとスキーマ変更が要るうえ、
 * モデルの乗り換えは**デプロイを伴う判断**（プロンプトの調整とセットで
 * 効果を見る）で、実行中に切り替えたい類のものではない。
 *
 * **既定値をコードに置く。** 環境変数が無くても動かないと、テストと
 * ローカル開発のたびに設定が要る。ただし**「直書きしない」の趣旨は守る** —
 * 呼び出し側はモデル名を知らず、ここを1か所直せば全ての段が変わる。
 */

import { aiNotConfiguredError } from './errors';
import type { ModelTier } from './tiers';

/** 対応するプロバイダー（SPEC「初期はAnthropicまたはOpenAIを1社利用」） */
export type AiProviderName = 'anthropic' | 'openai';

export const AI_PROVIDER_NAMES: readonly AiProviderName[] = [
  'anthropic',
  'openai',
];

export function isAiProviderName(value: string): value is AiProviderName {
  return (AI_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * 段ごとの既定のモデル。
 *
 * **ここが唯一のモデル名の置き場所。** 乗り換えるときはここか環境変数を
 * 直す。呼び出し側は段（`ModelTier`）しか知らない。
 */
const DEFAULT_MODELS: Readonly<
  Record<AiProviderName, Record<ModelTier, string>>
> = {
  anthropic: {
    LOW: 'claude-haiku-4-5-20251001',
    STANDARD: 'claude-sonnet-5',
    HIGH: 'claude-opus-5',
  },
  openai: {
    LOW: 'gpt-5-mini',
    STANDARD: 'gpt-5',
    HIGH: 'gpt-5',
  },
};

/** 段ごとの環境変数名 */
const MODEL_ENV_KEYS: Readonly<Record<ModelTier, string>> = {
  LOW: 'AI_MODEL_LOW',
  STANDARD: 'AI_MODEL_STANDARD',
  HIGH: 'AI_MODEL_HIGH',
};

/** 100万トークンあたりの単価（USD）の環境変数名 */
const PRICE_ENV_KEYS: Readonly<
  Record<ModelTier, { input: string; output: string }>
> = {
  LOW: { input: 'AI_PRICE_LOW_INPUT', output: 'AI_PRICE_LOW_OUTPUT' },
  STANDARD: {
    input: 'AI_PRICE_STANDARD_INPUT',
    output: 'AI_PRICE_STANDARD_OUTPUT',
  },
  HIGH: { input: 'AI_PRICE_HIGH_INPUT', output: 'AI_PRICE_HIGH_OUTPUT' },
};

export interface ModelPricing {
  /** 100万入力トークンあたりのUSD */
  inputPerMillion: number;
  /** 100万出力トークンあたりのUSD */
  outputPerMillion: number;
}

export interface ResolvedModel {
  provider: AiProviderName;
  tier: ModelTier;
  model: string;
  pricing: ModelPricing | null;
}

export interface AiConfigSource {
  /**
   * 差し替え用。既定は `process.env`。
   *
   * **`NodeJS.ProcessEnv` にしない。** あの型は `NODE_ENV` を必須にするため、
   * テストで「AIの設定だけを渡す」ことができなくなる。読むのは決まった
   * 数個の変数だけなので、素の辞書で足りる。
   */
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

function readEnv(
  source: AiConfigSource | undefined,
  key: string,
): string | null {
  const value = (source?.env ?? process.env)[key];

  return value === undefined || value.trim() === '' ? null : value.trim();
}

/**
 * 使うプロバイダーを決める。
 *
 * **未設定なら `anthropic`。** 1社しか使わない前提（SPEC）なので、
 * 選ばせないほうが事故が少ない。
 */
export function resolveProvider(source?: AiConfigSource): AiProviderName {
  const value = readEnv(source, 'AI_PROVIDER');

  if (value === null) {
    return 'anthropic';
  }

  if (!isAiProviderName(value)) {
    throw aiNotConfiguredError(
      `AI_PROVIDER が不正です（${AI_PROVIDER_NAMES.join(' / ')} のいずれか）`,
    );
  }

  return value;
}

/** 100万トークン単価を読む。両方そろっていなければ `null` */
function resolvePricing(
  tier: ModelTier,
  source?: AiConfigSource,
): ModelPricing | null {
  const keys = PRICE_ENV_KEYS[tier];
  const input = readEnv(source, keys.input);
  const output = readEnv(source, keys.output);

  if (input === null || output === null) {
    return null;
  }

  const inputPerMillion = Number(input);
  const outputPerMillion = Number(output);

  if (
    !Number.isFinite(inputPerMillion) ||
    !Number.isFinite(outputPerMillion) ||
    inputPerMillion < 0 ||
    outputPerMillion < 0
  ) {
    throw aiNotConfiguredError(
      `${keys.input} / ${keys.output} は0以上の数で指定してください`,
    );
  }

  return { inputPerMillion, outputPerMillion };
}

/**
 * 段に対応するモデルを決める（完了条件）。
 *
 * **環境変数が優先。** 無ければ既定値を使う。
 *
 * 料金は**そろっていなければ `null`**。片方だけの単価で計算すると、
 * 費用が実際より小さく出て予算通知（E-15）が鳴らない。
 */
export function resolveModel(
  tier: ModelTier,
  source?: AiConfigSource,
): ResolvedModel {
  const provider = resolveProvider(source);
  const configured = readEnv(source, MODEL_ENV_KEYS[tier]);

  return {
    provider,
    tier,
    model: configured ?? DEFAULT_MODELS[provider][tier],
    pricing: resolvePricing(tier, source),
  };
}

/**
 * APIキーを読む。
 *
 * **無ければ落とす。** 既定値を持たせようがない。**値をエラーメッセージへ
 * 入れない**（SPEC 14.2）。
 */
export function resolveApiKey(
  provider: AiProviderName,
  source?: AiConfigSource,
): string {
  const key =
    provider === 'anthropic'
      ? readEnv(source, 'ANTHROPIC_API_KEY')
      : readEnv(source, 'OPENAI_API_KEY');

  if (key === null) {
    throw aiNotConfiguredError(
      provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY が設定されていません'
        : 'OPENAI_API_KEY が設定されていません',
    );
  }

  return key;
}

/**
 * 使ったトークンから費用を求める（E-14 が使う）。
 *
 * 単価が未設定なら `null`。**0で埋めない** — 費用が計上されないまま
 * 予算を使い切る。
 */
export function estimateCostUsd(params: {
  pricing: ModelPricing | null;
  inputTokens: number;
  outputTokens: number;
}): number | null {
  if (params.pricing === null) {
    return null;
  }

  const input =
    (params.inputTokens / 1_000_000) * params.pricing.inputPerMillion;
  const output =
    (params.outputTokens / 1_000_000) * params.pricing.outputPerMillion;

  return input + output;
}
