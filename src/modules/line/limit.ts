/**
 * 通知数の制御（TASKS F-3、SPEC 8.3）。
 *
 * ```text
 * - デフォルト：1日1件
 * - 最大：1日2件
 * - 3ブログ合計で制限
 * - 緊急通知は別枠
 * ```
 *
 * ## 「3ブログ合計」は利用者単位で数えるということ
 *
 * ブログごとに1日1件にすると、3ブログ持つ人には**1日3件**届く。
 * 数える単位は利用者で、ブログではない。
 *
 * ## 上限を超える設定を受け付けない
 *
 * `monitor_profiles.max_daily_proposals` は整数の列で、DBは3以上も入る。
 * **読むときに丸める** — 設定画面の検証だけに頼ると、直接書き換えられた
 * 値がそのまま効く。
 *
 * DBも外部も触らない純粋な処理。
 */

/** SPEC 8.3「デフォルト：1日1件」 */
export const DEFAULT_DAILY_PROPOSAL_LIMIT = 1;
/** SPEC 8.3「最大：1日2件」 */
export const MAX_DAILY_PROPOSAL_LIMIT = 2;

/**
 * 1日に送ってよい件数を決める。
 *
 * **未設定なら既定の1件。** 0を許さないのは、0にすると提案が
 * 永久に届かないため — 止めたいなら利用者の状態を `PAUSED` にする
 * （F-2 が `ACTIVE` 以外へ送らない）。
 */
export function dailyNotificationLimit(
  maxDailyProposals: number | null | undefined,
): number {
  if (
    maxDailyProposals === null ||
    maxDailyProposals === undefined ||
    !Number.isFinite(maxDailyProposals)
  ) {
    return DEFAULT_DAILY_PROPOSAL_LIMIT;
  }

  const rounded = Math.floor(maxDailyProposals);

  if (rounded < DEFAULT_DAILY_PROPOSAL_LIMIT) {
    return DEFAULT_DAILY_PROPOSAL_LIMIT;
  }

  return Math.min(rounded, MAX_DAILY_PROPOSAL_LIMIT);
}

/**
 * あと何件送ってよいか。
 *
 * **既に上限を超えていても負を返さない。** 呼び出し側が
 * `slice(0, remaining)` に渡すため、負だと末尾から切り出してしまう。
 */
export function remainingNotificationSlots(params: {
  limit: number;
  sentToday: number;
}): number {
  return Math.max(0, params.limit - Math.max(0, params.sentToday));
}
