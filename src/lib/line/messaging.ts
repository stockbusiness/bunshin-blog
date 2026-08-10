/**
 * LINE Messaging API でメッセージを送る（TASKS F-2）。
 *
 * **SDKを入れず `fetch` で叩く**（`resend.ts` と同じ判断）。使うのは
 * push の1エンドポイントだけで、依存を1つ増やす価値が無い。
 */

import { logger } from '@/lib/logger';
import {
  LineNotConfiguredError,
  LineSendError,
  type LineClient,
  type LinePushRequest,
} from './types';

export const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

export interface LineConfig {
  /** Messaging API のチャネルアクセストークン。**秘密**（H-7 で暗号化して保存） */
  channelAccessToken: string;
}

export interface CreateLineClientOptions {
  fetchFn?: typeof fetch;
  /** 試験のために差し替える */
  endpoint?: string;
}

/**
 * 設定を読む。
 *
 * **足りない変数名だけを返す。値は返さない**（SPEC 14.2）。
 */
export function readLineConfig(
  source: Record<string, string | undefined>,
): { ok: true; config: LineConfig } | { ok: false; missing: string[] } {
  const token = source['LINE_CHANNEL_ACCESS_TOKEN']?.trim() ?? '';

  if (token === '') {
    return { ok: false, missing: ['LINE_CHANNEL_ACCESS_TOKEN'] };
  }

  return { ok: true, config: { channelAccessToken: token } };
}

export function createLineClient(
  config: LineConfig,
  options: CreateLineClientOptions = {},
): LineClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? LINE_PUSH_ENDPOINT;

  return {
    async push(request: LinePushRequest): Promise<void> {
      let response: Response;

      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.channelAccessToken}`,
            'content-type': 'application/json',
            // **同じ提案を二度送らない**（SPEC 8.3）。LINE 側でも止める
            ...(request.retryKey === undefined
              ? {}
              : { 'x-line-retry-key': request.retryKey }),
          },
          body: JSON.stringify({
            to: request.to,
            messages: request.messages,
          }),
        });
      } catch (cause) {
        throw new LineSendError('LINE への送信に失敗しました', { cause });
      }

      if (!response.ok) {
        // **応答本文をそのまま投げない。** 宛先のユーザーIDが載りうる（SPEC 14.2）
        const detail = await response.text().catch(() => '');
        logger.error('LINE の送信APIがエラーを返した', {
          status: response.status,
          detail,
        });

        throw new LineSendError('LINE への送信に失敗しました');
      }
    },
  };
}

/**
 * 設定から送信クライアントを作る。
 *
 * @throws {LineNotConfiguredError} 設定が足りない
 */
export function requireLineClient(
  source: Record<string, string | undefined>,
  options: CreateLineClientOptions = {},
): LineClient {
  const result = readLineConfig(source);

  if (!result.ok) {
    throw new LineNotConfiguredError(result.missing);
  }

  return createLineClient(result.config, options);
}
