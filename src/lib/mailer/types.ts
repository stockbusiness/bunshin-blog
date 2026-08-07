/**
 * メール送信の入口（B-11、OPEN_QUESTIONS Q-013）。
 *
 * **送信基盤を差し替えられる形にする。** Phase 0 は Resend を使うが、
 * 送信量が増えれば見直す。呼び出し側がこのインターフェースだけを見て
 * いれば、差し替えても影響しない。
 *
 * **送るのは管理者のログインリンクだけ**（Q-013）。モニターへの通知は
 * LINE（SPEC 2.x・F-2）であり、メールへ広げない。
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** 本文はテキストのみ。HTMLメールは Phase 0 では作らない */
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** 送信に失敗したことを表す。原因はログにのみ残す */
export class MailSendError extends Error {
  override readonly name = 'MailSendError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
  }
}

/** 設定が足りず送信できないことを表す */
export class MailNotConfiguredError extends Error {
  override readonly name = 'MailNotConfiguredError';

  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(`メール送信の設定が不足しています: ${missing.join(', ')}`);
    this.missing = missing;
  }
}
