import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  fromNotificationTimeColumn,
  normalizeNotificationSchedule,
  toNotificationTimeColumn,
} from '@/modules/users';

/**
 * 通知の曜日と時刻の検証（TASKS H-2b、SPEC 8.3）。
 *
 * **時刻はJSTの壁掛け時計。** UTCへ直して入れると、読む側（F-3b）が
 * 9時間ずらす処理を持つことになり、ずらし忘れが必ず起きる。
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('通るもの', () => {
  it('曜日と時刻を整える', () => {
    expect(
      normalizeNotificationSchedule({ days: [5, 1, 3], time: '07:30' }),
    ).toEqual({ days: [1, 3, 5], time: '07:30' });
  });

  it('重複を落とす', () => {
    expect(
      normalizeNotificationSchedule({ days: [1, 1, 2], time: '07:00' }).days,
    ).toEqual([1, 2]);
  });

  it.each([['00:00'], ['09:05'], ['23:59']])('時刻 %s を通す', (time) => {
    expect(normalizeNotificationSchedule({ days: [0], time }).time).toBe(time);
  });
});

describe('拒むもの', () => {
  /**
   * **1日も選ばずに保存させない。** 保存はできるが通知が一度も飛ばない
   * 状態は、「設定済みなのに来ない」という一番分かりにくい形になる
   */
  it('曜日が空なら拒む', () => {
    expect(
      codeOf(() => normalizeNotificationSchedule({ days: [], time: '07:00' })),
    ).not.toBe('NO_THROW');
  });

  it.each([[-1], [7], [1.5], ['1']])('曜日 %o を拒む', (day) => {
    expect(
      codeOf(() =>
        normalizeNotificationSchedule({ days: [day], time: '07:00' }),
      ),
    ).not.toBe('NO_THROW');
  });

  it.each([['7:00'], ['24:00'], ['07:60'], ['朝'], [700]])(
    '時刻 %o を拒む',
    (time) => {
      expect(
        codeOf(() => normalizeNotificationSchedule({ days: [1], time })),
      ).not.toBe('NO_THROW');
    },
  );

  it.each([[null], [undefined], ['x'], [{}]])('形が違う %o を拒む', (input) => {
    expect(codeOf(() => normalizeNotificationSchedule(input))).not.toBe(
      'NO_THROW',
    );
  });
});

/**
 * **`Z` は入れ物の都合で、意味はJSTの壁掛け時計**（`jstDateColumn` と
 * 同じ考え方・Q-031）。入れて出して同じ値に戻ることを確かめる
 */
describe('time 列との往復', () => {
  it.each([['00:00'], ['07:30'], ['21:00'], ['23:59']])(
    '%s は往復しても変わらない',
    (time) => {
      expect(fromNotificationTimeColumn(toNotificationTimeColumn(time))).toBe(
        time,
      );
    },
  );

  it('UTCへずらさない', () => {
    // 21:00 を入れたら 21:00。9時間引かない
    expect(toNotificationTimeColumn('21:00').toISOString()).toBe(
      '1970-01-01T21:00:00.000Z',
    );
  });
});
