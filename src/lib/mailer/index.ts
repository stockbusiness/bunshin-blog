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

/**
 * 設定から送信手段を組み立てる。
 *
 * **キャッシュしない**（H-10）。以前は最初の1回を覚えていたが、
 * **管理画面で鍵を差し替えても古い設定のまま送り続ける**ことになる
 * （インスタンスが入れ替わるまで直らず、しかもサーバーレスでは
 * 入れ替わる時期が読めない）。組み立ては設定を包むだけで、費用は無い。
 *
 * 渡す `source` は `getRuntimeEnv()`（H-7）の戻り値にする。
 * `process.env` を直接渡すと、DBに保存した設定が効かない。
 */
export function getMailer(
  source: Record<string, string | undefined> = process.env,
): Mailer {
  const result = readResendConfig(source);

  return result.ok === true
    ? createResendMailer(result.config)
    : createUnconfiguredMailer(result.missing);
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
