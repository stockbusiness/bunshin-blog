import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_WINDOW_MINUTES,
  UNSENT_PROPOSAL_TTL_DAYS,
  isWithinNotificationWindow,
} from '@/modules/line';

/**
 * 通知してよい時間帯の判定（TASKS F-3b、SPEC 8.3、Q-025）。
 *
 * **JSTで判定する。** UTCで曜日を見ると、日本の朝が前日として判定される。
 */

/** 2026-08-12 は水曜（JST）。UTCでは 2026-08-11 の夜 */
const WED_0700_JST = new Date('2026-08-11T22:00:00.000Z');
const WED_0000_JST = new Date('2026-08-11T15:00:00.000Z');

const WEDNESDAY = 3;
const THURSDAY = 4;

function schedule(days: number[], time: string) {
  return { days, time };
}

describe('曜日', () => {
  it('指定した曜日なら通る', () => {
    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '07:00'),
        now: WED_0700_JST,
      }),
    ).toBe(true);
  });

  it('指定していない曜日は通らない', () => {
    expect(
      isWithinNotificationWindow({
        schedule: schedule([THURSDAY], '07:00'),
        now: WED_0700_JST,
      }),
    ).toBe(false);
  });

  /**
   * **JSTの曜日で見る。** JST 0:00 は UTC では前日の15:00。
   * `now.getUTCDay()` で見ると火曜と判定され、水曜を選んだ人へ届かない
   */
  it('JSTの深夜でも、その日のJST曜日で判定する', () => {
    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '00:00'),
        now: WED_0000_JST,
      }),
    ).toBe(true);
  });
});

describe('時刻の幅', () => {
  /** ジョブが分単位で必ずその時刻に走る保証は無い */
  it('指定時刻ちょうどは通る', () => {
    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '07:00'),
        now: WED_0700_JST,
      }),
    ).toBe(true);
  });

  it('幅の中なら通る', () => {
    const later = new Date(
      WED_0700_JST.getTime() + (NOTIFICATION_WINDOW_MINUTES - 1) * 60_000,
    );

    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '07:00'),
        now: later,
      }),
    ).toBe(true);
  });

  /** **幅を過ぎたら翌日へ持ち越す。** 夜中に届くくらいなら翌朝のほうがよい */
  it('幅を過ぎたら通らない', () => {
    const tooLate = new Date(
      WED_0700_JST.getTime() + NOTIFICATION_WINDOW_MINUTES * 60_000,
    );

    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '07:00'),
        now: tooLate,
      }),
    ).toBe(false);
  });

  /** **「07:00 に届く」と決めた人へ 06:00 に送らない** */
  it('指定時刻より前は通らない', () => {
    const early = new Date(WED_0700_JST.getTime() - 60_000);

    expect(
      isWithinNotificationWindow({
        schedule: schedule([WEDNESDAY], '07:00'),
        now: early,
      }),
    ).toBe(false);
  });
});

/**
 * **未設定なら止めない。** ここで止めると、設定していないだけの人へ
 * 通知が一切届かなくなる（F-3 までの挙動を、設定の有無で黙って変えない）
 */
describe('未設定', () => {
  it.each([
    { name: '設定が無い', value: null },
    { name: '曜日が空', value: schedule([], '07:00') },
  ])('$name なら常に通る', ({ value }) => {
    expect(
      isWithinNotificationWindow({ schedule: value, now: WED_0000_JST }),
    ).toBe(true);
  });
});

describe('期限切れまでの日数', () => {
  /** 曜日をどう絞っても、1日以上選んでいれば7日のうちに通知日が来る */
  it('7日', () => {
    expect(UNSENT_PROPOSAL_TTL_DAYS).toBe(7);
  });
});
