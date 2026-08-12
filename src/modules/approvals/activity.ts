/**
 * モニターが提案に反応しているかを測る（TASKS J-5）。
 *
 * ## なぜ要るのか
 *
 * **Phase 0 で最も起きやすい失敗は「モニターが承認しない」**である。
 * 提案は届く、でも押されない。**画面には何も起きていないように見える。**
 *
 * ROADMAP は8週間継続率を見ることにしているが、**8週間は遅すぎる。**
 * 90日のうち8週間を使ってから「この人は最初の2週間で離れていた」と
 * 分かっても、**その人の枠はもう戻らない。**
 *
 * ## 「送っていない」と「送ったが押していない」を分ける
 *
 * **ここが要。** 提案が1件も届いていない人の承認率を 0% にすると、
 * **仕組みが止まっているのか、人が離れたのか区別できない。**
 *
 * 前者は Bunshin の問題（構成表・記事生成・通知のどこかが止まっている）、
 * 後者はモニターの問題で、**打つ手がまったく違う。**
 *
 * ## 少ない件数で決めつけない
 *
 * 1件送って押されなければ 0% になる。**判定に足る数を決めておく**
 * （G-8b の `MIN_JUDGED_ARTICLES` と同じ考え）。
 *
 * DBも外部も触らない純粋な処理。
 */

/** 見る期間。**14日。** 通知は最大でも1日2件（SPEC 8.3）なので、
 * 2週間でようやく判定に足る数になる */
export const ACTIVITY_WINDOW_DAYS = 14;

/** 判定に足る最小の送信数。**これ未満は判定しない** */
export const MIN_SENT_FOR_JUDGEMENT = 3;

/** これを下回ったら知らせる */
export const LOW_RESPONSE_RATE = 0.5;

export type ActivityVerdict =
  /** 送れていない。**Bunshin 側の問題** */
  | 'NOTHING_SENT'
  /** 送った数が判定に足りない */
  | 'NOT_ENOUGH_DATA'
  /** 反応している */
  | 'ACTIVE'
  /** 届いているのに押されていない。**モニター側の問題** */
  | 'LOW_RESPONSE';

export interface ActivityCounts {
  /** 期間内に送った提案の数 */
  sent: number;
  /** そのうち、何らかの判断がされた数（承認・見送り・修正依頼） */
  responded: number;
}

export interface ActivityJudgement {
  verdict: ActivityVerdict;
  /**
   * 反応した割合。
   *
   * **判定できないときは `null`。** 0 を返すと「押していない」と
   * 読めてしまう（G-8b で率を返さなかったのと同じ理由）。
   */
  rate: number | null;
}

/**
 * 反応の具合を判定する。
 *
 * **`NOTHING_SENT` を最初に見る。** 送れていないのに「反応が悪い」と
 * 出すと、**直す相手を間違える。**
 */
export function judgeApprovalActivity(
  counts: ActivityCounts,
): ActivityJudgement {
  if (counts.sent === 0) {
    return { verdict: 'NOTHING_SENT', rate: null };
  }

  if (counts.sent < MIN_SENT_FOR_JUDGEMENT) {
    return { verdict: 'NOT_ENOUGH_DATA', rate: null };
  }

  const rate = counts.responded / counts.sent;

  return {
    verdict: rate < LOW_RESPONSE_RATE ? 'LOW_RESPONSE' : 'ACTIVE',
    rate,
  };
}

/** 画面に出す文言。**何をすればよいかまで書く** */
export const ACTIVITY_LABELS: Readonly<Record<ActivityVerdict, string>> = {
  NOTHING_SENT: '提案が届いていない（仕組み側を確認）',
  NOT_ENOUGH_DATA: '判定に足る件数が届いていない',
  ACTIVE: '反応している',
  LOW_RESPONSE: '届いているが反応が少ない（声かけを検討）',
};
