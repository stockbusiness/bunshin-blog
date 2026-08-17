/**
 * 8週間継続率（SPEC 16.2、Q-043。2026-08-17 の決定）。
 *
 * > **8週間継続率は、利用開始から43日目〜56日目の14日間に、
 * > 承認・修正依頼・見送りのいずれかを1件以上行ったモニターを
 * > 「継続」と定義する。**
 *
 * ## `activity.ts` と何が違うのか
 *
 * あちらは**移動する14日窓**で、日々の見守り用（J-5）。
 * **こちらは利用者ごとに位置が違う固定期間**で、検証のKPI。
 *
 * **移動窓でKPIを出すと、集計した日によって率が動く。**
 * 90日の一次データとしては使えない。
 *
 * ## 日数の数え方
 *
 * **利用開始日を1日目とする。**
 *
 * ```
 * 43日目 = activated_at + 42日
 * 56日目 = activated_at + 56日 の直前まで
 * 判定期間 = [activated_at + 42日, activated_at + 56日)  ちょうど14日間
 * 対象者   = activated_at + 56日 <= いま
 * ```
 *
 * **ここを1日ずらすと、KPIが黙って別のものになる。** 数え方をコードに置く。
 *
 * **JSTの暦日ではなく、瞬間で数える。** 起点の `activated_at` は
 * `timestamptz` で、利用者ごとに時刻が違う。暦日へ丸めると、
 * **深夜に参加を認めた人だけ窓が1日ずれる。**
 *
 * ## 提案が届かなかった人を分母から外さない
 *
 * 外すと、**ジョブ停止や通知障害による未活動が見えなくなる。**
 * そのぶん、原因を分けるための数を別に返す。
 *
 * DBも外部も触らない純粋な処理。
 */

const MS_PER_DAY = 86_400_000;

/** 判定期間の始まり（利用開始日を1日目として43日目） */
export const RETENTION_START_DAY = 43;

/** 判定期間の終わり（56日目まで。8週間） */
export const RETENTION_END_DAY = 56;

export interface RetentionWindow {
  start: Date;
  endExclusive: Date;
}

/**
 * 判定期間を求める。
 *
 * `43日目` は**開始から42日後**（開始日が1日目のため）。
 */
export function retentionWindow(activatedAt: Date): RetentionWindow {
  const base = activatedAt.getTime();

  return {
    start: new Date(base + (RETENTION_START_DAY - 1) * MS_PER_DAY),
    endExclusive: new Date(base + RETENTION_END_DAY * MS_PER_DAY),
  };
}

/** 8週間を過ぎたか。**過ぎるまでは分母に入れない** */
export function isRetentionEligible(activatedAt: Date, now: Date): boolean {
  return now.getTime() >= retentionWindow(activatedAt).endExclusive.getTime();
}

export interface RetentionEntry {
  userId: string;
  /** 判定期間に届いた提案の数 */
  sent: number;
  /** 判定期間に行った判断の数（承認・修正依頼・見送り） */
  decided: number;
}

export interface RetentionSummary {
  /** 分母。8週間を過ぎたモニター */
  eligible: number;
  /** 分子。判定期間に1件以上判断した人 */
  continued: number;
  /**
   * 継続率。
   *
   * **対象者が0人なら `null`。** 0 を返すと「誰も続かなかった」に見え、
   * 100 を返すと「全員続いた」に見える（どちらも嘘）。
   */
  rate: number | null;
  /**
   * 判定期間に提案が1件も届かなかった人数。
   *
   * **この人たちは分母に入っている。** 外すと、ジョブ停止や
   * 通知障害による未活動が見えなくなる。**別に数えて原因を分ける。**
   */
  noProposal: number;
  /** 提案が届いた人のうち、1件以上判断した人の割合。**0人なら `null`** */
  respondedRateAmongSent: number | null;
}

/**
 * 継続率をまとめる。
 *
 * **`eligible` に渡すのは、8週間を過ぎた人だけ**（`isRetentionEligible`）。
 * 過ぎていない人を混ぜると、**まだ判定できない人が「続かなかった」に入る。**
 */
export function summarizeRetention(
  entries: readonly RetentionEntry[],
): RetentionSummary {
  const eligible = entries.length;
  const continued = entries.filter((entry) => entry.decided > 0).length;
  const withProposal = entries.filter((entry) => entry.sent > 0);
  const continuedWithProposal = withProposal.filter(
    (entry) => entry.decided > 0,
  ).length;

  return {
    eligible,
    continued,
    rate: eligible === 0 ? null : continued / eligible,
    noProposal: eligible - withProposal.length,
    respondedRateAmongSent:
      withProposal.length === 0
        ? null
        : continuedWithProposal / withProposal.length,
  };
}
