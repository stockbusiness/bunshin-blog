/**
 * AIプロバイダーの公開インターフェース（TASKS E-3）。
 *
 * **サーバー専用。** APIキーを扱うため、ブラウザ向けのコードから
 * import しない（MODULE_RULES 4）。
 *
 * **モデル名を呼び出し側に書かせない**（SPEC「モデル名をコードに直書き
 * しない」）。渡すのは用途（`AiOperation`）だけで、段とモデルは
 * `config.ts` が決める。
 */

export {
  createAiProvider,
  AI_TIMEOUT_MS,
  type AiProvider,
  type AiMessage,
  type AiCompletionRequest,
  type AiCompletionResult,
  type CreateAiProviderOptions,
} from './provider';

export {
  resolveModel,
  resolveProvider,
  resolveApiKey,
  estimateCostUsd,
  isAiProviderName,
  AI_PROVIDER_NAMES,
  type AiProviderName,
  type ModelPricing,
  type ResolvedModel,
  type AiConfigSource,
} from './config';

export {
  tierForOperation,
  operationsForTier,
  isAiOperation,
  isModelTier,
  AI_OPERATIONS,
  MODEL_TIERS,
  type AiOperation,
  type ModelTier,
} from './tiers';

export {
  AI_ERROR_CODES,
  aiNotConfiguredError,
  aiRequestFailedError,
  type AiErrorCode,
} from './errors';
