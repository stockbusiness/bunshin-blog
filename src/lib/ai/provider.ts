/**
 * AIプロバイダーの抽象化（TASKS E-3、SPEC「プロバイダー抽象化」）。
 *
 * 呼び出し側が知るのは**用途（`AiOperation`）**だけ。モデル名も
 * プロバイダーの作法も、ここから外へ出さない。
 *
 * ## `safeFetch` を通さない
 *
 * 宛先は**こちらが決めた固定のURL**で、利用者が入力した値ではない。
 * SSRF対策（C-7）が守るのは「利用者が宛先を決められるリクエスト」で、
 * ここは当てはまらない。代わりに**タイムアウトだけは自前で掛ける** —
 * サーバーレスでは応答を待ち続けると関数ごと殺される（E-1）。
 */

import { AI_ERROR_CODES, aiRequestFailedError } from './errors';
import {
  estimateCostUsd,
  resolveApiKey,
  resolveModel,
  type AiConfigSource,
  type AiProviderName,
} from './config';
import { tierForOperation, type AiOperation } from './tiers';

/** 1回の呼び出しに許す時間。関数の実行時間（E-1）に収める */
export const AI_TIMEOUT_MS = 120_000;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  /** 何をさせるか。ここから段とモデルが決まる（SPEC 9.8） */
  operation: AiOperation;
  /** 役割の指示 */
  system?: string | undefined;
  messages: readonly AiMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
}

export interface AiCompletionResult {
  text: string;
  provider: AiProviderName;
  /** 実際に使ったモデル名（`ai_usage_logs.model` に入れる） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 単価が未設定なら `null`（E-14 が扱う） */
  costUsd: number | null;
}

export interface AiProvider {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

export interface CreateAiProviderOptions extends AiConfigSource {
  /** 差し替え用。既定は `fetch` */
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** 差し替え用。既定はプロバイダーごとの公開URL */
  baseUrl?: string | undefined;
}

const DEFAULT_BASE_URLS: Readonly<Record<AiProviderName, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** Anthropic Messages API の版。**上げるときは応答の形も確かめる** */
const ANTHROPIC_VERSION = '2023-06-01';

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Anthropic の応答から本文を取り出す。
 *
 * `content` は配列で、`type: 'text'` 以外（道具の呼び出しなど）が
 * 混ざりうる。**テキストだけを繋ぐ。**
 */
function readAnthropicText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const content = (json as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text);

  return parts.length === 0 ? null : parts.join('');
}

function readAnthropicUsage(json: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage =
    typeof json === 'object' && json !== null
      ? (json as Record<string, unknown>)['usage']
      : undefined;

  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const record = usage as Record<string, unknown>;

  return {
    inputTokens: readNumber(record['input_tokens']),
    outputTokens: readNumber(record['output_tokens']),
  };
}

/**
 * プロバイダーを作る。
 *
 * **段とモデルの決定は呼び出しのたびに行う。** 起動時に固めると、
 * 環境変数を変えても再デプロイまで効かない。
 */
export function createAiProvider(
  options: CreateAiProviderOptions = {},
): AiProvider {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;

  return {
    async complete(request) {
      const tier = tierForOperation(request.operation);
      const resolved = resolveModel(tier, options);
      const apiKey = resolveApiKey(resolved.provider, options);

      if (resolved.provider !== 'anthropic') {
        // OpenAI は E-3 の時点で使わない。**黙って別の作法で投げない**
        throw aiRequestFailedError(
          AI_ERROR_CODES.notConfigured,
          'いまは Anthropic のみ対応しています',
        );
      }

      const baseUrl = options.baseUrl ?? DEFAULT_BASE_URLS[resolved.provider];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: resolved.model,
            max_tokens: request.maxOutputTokens,
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw aiRequestFailedError(
            AI_ERROR_CODES.timeout,
            `AIが${timeoutMs}ms以内に応答しませんでした`,
            error,
          );
        }

        throw aiRequestFailedError(
          AI_ERROR_CODES.unreachable,
          'AIプロバイダーへ接続できませんでした',
          error,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // **応答本文をそのまま返さない。** 課金情報や内部の識別子が混ざりうる
        throw aiRequestFailedError(
          AI_ERROR_CODES.requestFailed,
          `AIプロバイダーがエラーを返しました（HTTP ${response.status}）`,
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (error) {
        throw aiRequestFailedError(
          AI_ERROR_CODES.invalidResponse,
          'AIの応答を読めませんでした',
          error,
        );
      }

      const text = readAnthropicText(json);
      if (text === null) {
        throw aiRequestFailedError(
          AI_ERROR_CODES.invalidResponse,
          'AIの応答に本文がありませんでした',
        );
      }

      const usage = readAnthropicUsage(json);

      return {
        text,
        provider: resolved.provider,
        model: resolved.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: estimateCostUsd({ pricing: resolved.pricing, ...usage }),
      };
    },
  };
}
