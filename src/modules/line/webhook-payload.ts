/**
 * LINE Webhook の電文の読み取り（TASKS D-7b、SPEC 8.4）。
 *
 * DBも外部も触らない純粋な処理。**署名の検証は済んでいる前提**
 * （`verifyLineSignature`）。ここは「何が届いたか」を形にするだけ。
 *
 * ## 扱うのはテキストの返信だけ
 *
 * LINE は友だち追加・スタンプ・画像・既読など**多くの種類**を同じ入口へ
 * 送ってくる。Phase 0 で読むのは SPEC 8.4 の4種類＝**テキストの返信**だけ。
 *
 * **知らない種類は「落とした」と数えて捨てる。** 例外にすると、
 * スタンプが1つ届いただけで受け口全体が失敗する。
 *
 * ## 1件が壊れていても全部を落とさない
 *
 * LINE は 200 以外を返すと**同じ電文を再送**する。壊れた1件のために
 * 400 を返すと、**その電文が延々と送られ続ける**（D-12 の受信APIと
 * 同じ判断）。通るものだけ通す。
 *
 * ## 再送で二重に保存しない
 *
 * `webhookEventId` は LINE が採番する識別子で、**再送でも同じ値**。
 * これをジョブの冪等キーにする（`link_clicks.event_id` と同じ形）。
 */

/** 1件の返信 */
export interface LineTextReply {
  /** LINE が採番する識別子。**再送でも同じ**。ジョブの冪等キーにする */
  webhookEventId: string;
  /** `users.line_user_id` と突き合わせる値。**これ自体は身元** */
  lineUserId: string;
  text: string;
  /** LINE 側の発生時刻 */
  timestamp: Date;
}

export interface ParsedWebhook {
  replies: LineTextReply[];
  /** 読めなかった・扱わない種類の件数。**数だけ**（中身はログにも残さない） */
  skipped: number;
}

/** 返信の長さの上限。LINE のテキストは5000文字まで */
export const REPLY_TEXT_MAX_LENGTH = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 1件を読む。扱えなければ `null`。
 *
 * **`replyToken` は読まない。** 返信トークンは1分ほどで切れるので、
 * ジョブに載せた頃には使えない。案内は push で送る（`reply-intake`）。
 */
function readTextReply(event: unknown): LineTextReply | null {
  if (!isRecord(event)) {
    return null;
  }

  // **メッセージ以外は扱わない**（友だち追加・既読・postback など）。
  // postback（「今回は見送る」）の受け口は F-6
  if (event['type'] !== 'message') {
    return null;
  }

  const message = event['message'];

  if (!isRecord(message) || message['type'] !== 'text') {
    return null;
  }

  const source = event['source'];
  const lineUserId = isRecord(source) ? readString(source['userId']) : null;
  const webhookEventId = readString(event['webhookEventId']);
  const text = readString(message['text']);

  if (lineUserId === null || webhookEventId === null || text === null) {
    return null;
  }

  // **長すぎる返信は切らずに落とす。** 途中で切った文を事実として保存すると、
  // 書き手の言っていないことが記憶に残る
  if (text.length > REPLY_TEXT_MAX_LENGTH) {
    return null;
  }

  const timestamp = event['timestamp'];

  return {
    webhookEventId,
    lineUserId,
    text,
    // **時刻が読めなくても落とさない。** 返信そのものは届いている
    timestamp:
      typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? new Date(timestamp)
        : new Date(0),
  };
}

/**
 * Webhook の本文を読む。
 *
 * **本文の形が違っても例外にしない。** 呼び出し側は 200 を返すため
 * （再送を止める）、読めなかったことは `skipped` で数える。
 */
export function parseLineWebhook(body: unknown): ParsedWebhook {
  if (!isRecord(body) || !Array.isArray(body['events'])) {
    return { replies: [], skipped: 0 };
  }

  const replies: LineTextReply[] = [];
  let skipped = 0;

  for (const event of body['events']) {
    const reply = readTextReply(event);

    if (reply === null) {
      skipped += 1;
      continue;
    }

    replies.push(reply);
  }

  return { replies, skipped };
}
