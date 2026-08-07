import { logger } from '@/lib/logger';
import {
  MailNotConfiguredError,
  MailSendError,
  type MailMessage,
  type Mailer,
} from './types';

/**
 * Resend でメールを送る（B-11、OPEN_QUESTIONS Q-013）。
 *
 * **SDKを入れず `fetch` で叩く。** 送るのは1種類のメールだけで、
 * 依存を1つ増やす価値が無い。
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendConfig {
  apiKey: string;
  /** 送信元。Resend でドメイン認証済みのアドレス */
  from: string;
}

export interface CreateResendMailerOptions {
  fetchFn?: typeof fetch;
}

/**
 * 環境変数から設定を読む。
 *
 * **足りない変数名だけを返す。値は返さない**（SPEC 14.2）。
 */
export function readResendConfig(
  source: Record<string, string | undefined>,
): { ok: true; config: ResendConfig } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  const apiKey = source['RESEND_API_KEY']?.trim() ?? '';
  const from = source['MAIL_FROM']?.trim() ?? '';

  if (apiKey === '') missing.push('RESEND_API_KEY');
  if (from === '') missing.push('MAIL_FROM');

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, config: { apiKey, from } };
}

export function createResendMailer(
  config: ResendConfig,
  options: CreateResendMailerOptions = {},
): Mailer {
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return {
    async send(message: MailMessage): Promise<void> {
      let response: Response;

      try {
        response = await fetchFn(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
        });
      } catch (cause) {
        throw new MailSendError('メールの送信に失敗しました', { cause });
      }

      if (!response.ok) {
        // 応答本文にはAPIキーは含まれないが、宛先が載りうるためログにのみ出す
        const detail = await response.text().catch(() => '');
        logger.error('メール送信APIがエラーを返した', {
          status: response.status,
          detail,
        });

        throw new MailSendError('メールの送信に失敗しました');
      }
    },
  };
}

/** 設定が足りないときに使う。呼ばれた時点で失敗する */
export function createUnconfiguredMailer(missing: string[]): Mailer {
  return {
    send(): Promise<void> {
      return Promise.reject(new MailNotConfiguredError(missing));
    },
  };
}
