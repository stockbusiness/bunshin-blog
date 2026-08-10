import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_PROPOSAL_LIMIT,
  MAX_DAILY_PROPOSAL_LIMIT,
  dailyNotificationLimit,
  remainingNotificationSlots,
} from '@/modules/line';

/**
 * 通知数の制御（TASKS F-3、SPEC 8.3）。
 *
 * ```text
 * - デフォルト：1日1件
 * - 最大：1日2件
 * - 3ブログ合計で制限
 * ```
 */

describe('1日の上限（SPEC 8.3）', () => {
  it('既定は1件', () => {
    expect(dailyNotificationLimit(null)).toBe(DEFAULT_DAILY_PROPOSAL_LIMIT);
    expect(dailyNotificationLimit(undefined)).toBe(1);
  });

  it('2件までは設定できる', () => {
    expect(dailyNotificationLimit(2)).toBe(2);
  });

  /**
   * **DBは3以上も入る整数の列。** 設定画面の検証だけに頼ると、
   * 直接書き換えられた値がそのまま効く
   */
  it('3件以上は2件に丸める', () => {
    expect(dailyNotificationLimit(3)).toBe(MAX_DAILY_PROPOSAL_LIMIT);
    expect(dailyNotificationLimit(100)).toBe(2);
  });

  /**
   * **0を許さない。** 0にすると提案が永久に届かない。
   * 止めたいなら利用者の状態を `PAUSED` にする（F-2 が送らない）
   */
  it('0以下は1件に上げる', () => {
    expect(dailyNotificationLimit(0)).toBe(1);
    expect(dailyNotificationLimit(-5)).toBe(1);
  });

  it('小数は切り捨てる', () => {
    expect(dailyNotificationLimit(1.9)).toBe(1);
  });

  it('数でない値は既定へ落とす', () => {
    expect(dailyNotificationLimit(Number.NaN)).toBe(1);
  });
});

describe('残り枠', () => {
  it('送った分だけ減る', () => {
    expect(remainingNotificationSlots({ limit: 2, sentToday: 1 })).toBe(1);
  });

  it('使い切れば0', () => {
    expect(remainingNotificationSlots({ limit: 1, sentToday: 1 })).toBe(0);
  });

  /**
   * **負を返さない。** 呼び出し側が `slice(0, remaining)` に渡すため、
   * 負だと末尾から切り出してしまう
   */
  it('上限を超えていても0で止まる', () => {
    expect(remainingNotificationSlots({ limit: 1, sentToday: 5 })).toBe(0);
  });

  it('まだ送っていなければ上限どおり', () => {
    expect(remainingNotificationSlots({ limit: 2, sentToday: 0 })).toBe(2);
  });
});
