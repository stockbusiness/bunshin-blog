import {
  createResendMailer,
  createUnconfiguredMailer,
  readResendConfig,
} from './resend';
import type { Mailer } from './types';

/**
 * メール送信の公開インターフェース（B-11）。
 *
 * **設定が無くても起動を止めない**（Q-013）。`RESEND_API_KEY` などが
 * 未設定でも LIFF 側（モニターの利用）は動く必要があるため、
 * `src/lib/env.ts` の必須項目には入れない。管理者ログインを試みたときに
 * 設定不足として扱う。
 */

let cached: Mailer | null = null;

export function getMailer(
  source: Record<string, string | undefined> = process.env,
): Mailer {
  if (cached !== null) {
    return cached;
  }

  const result = readResendConfig(source);
  cached =
    result.ok === true
      ? createResendMailer(result.config)
      : createUnconfiguredMailer(result.missing);

  return cached;
}

/** テストから状態を戻す */
export function resetMailerCache(): void {
  cached = null;
}

export {
  createResendMailer,
  createUnconfiguredMailer,
  readResendConfig,
  RESEND_ENDPOINT,
  type ResendConfig,
} from './resend';

export {
  MailSendError,
  MailNotConfiguredError,
  type Mailer,
  type MailMessage,
} from './types';
