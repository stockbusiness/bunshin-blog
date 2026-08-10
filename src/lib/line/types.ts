/**
 * LINE メッセージ送信の入口（TASKS F-2、SPEC 8.1・8.2）。
 *
 * **送信基盤を差し替えられる形にする**（`Mailer` と同じ考え）。
 * 呼び出し側はこのインターフェースだけを見る。
 *
 * ## 宛先を文字列で受けない
 *
 * `to` は LINE のユーザーID。**呼び出し側が組み立てるのではなく、
 * `users.line_user_id` から取ったものだけを渡す** — 他人のIDを渡せる形に
 * すると、提案が別人に届く（C-6 と同じ形の穴）。
 */

/** LINE へ送るメッセージ（SPEC 8.2 の通知フォーマット） */
export interface LineTextMessage {
  type: 'text';
  text: string;
}

/**
 * ボタン付きのメッセージ。
 *
 * SPEC 8.2 は「内容を確認」「今回は見送る」の2つを求めている。
 * LINE の Template Message（buttons）で表す。
 */
export interface LineButtonsMessage {
  type: 'template';
  altText: string;
  template: {
    type: 'buttons';
    title: string;
    text: string;
    actions: LineAction[];
  };
}

export type LineAction =
  | { type: 'uri'; label: string; uri: string }
  | { type: 'postback'; label: string; data: string; displayText?: string };

export type LineMessage = LineTextMessage | LineButtonsMessage;

export interface LinePushRequest {
  /** `users.line_user_id` */
  to: string;
  messages: LineMessage[];
  /**
   * 同じ鍵で二度送らないよう LINE 側に伝える値。
   *
   * **提案IDを使う。** 再試行で二重に届くのを LINE 側でも止める
   * （SPEC 8.3「同一提案を連続通知しない」）。
   */
  retryKey?: string | undefined;
}

export interface LineClient {
  push(request: LinePushRequest): Promise<void>;
}

/** 送信に失敗したことを表す。原因はログにのみ残す */
export class LineSendError extends Error {
  override readonly name = 'LineSendError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
  }
}

/** 設定が足りず送信できないことを表す */
export class LineNotConfiguredError extends Error {
  override readonly name = 'LineNotConfiguredError';

  readonly missing: readonly string[];

  constructor(missing: string[]) {
    super(`LINE の設定が不足しています: ${missing.join(', ')}`);
    this.missing = missing;
  }
}
