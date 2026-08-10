import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSIONS_PER_WEEK,
  MAX_REVENUE_YEN_PER_WEEK,
  WEEKLY_RESULT_ERROR_CODES,
  normalizeWeeklyResult,
  weekOf,
} from '@/modules/analytics';

/**
 * 手動の収益入力の検査（TASKS G-5、SPEC 6.1）。
 *
 * 完了条件は「成果件数と報酬額のみ入力。**0件を1操作で記録できる**」。
 */

function codeOf(run: () => unknown): string {
  try {
    run();

    return 'NO_THROW';
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
}

describe('入力の検査', () => {
  it('0件0円を通す（完了条件）', () => {
    expect(normalizeWeeklyResult({ conversions: 0, revenueYen: 0 })).toEqual({
      conversions: 0,
      revenueYen: 0,
    });
  });

  it('通常の値を通す', () => {
    expect(
      normalizeWeeklyResult({ conversions: 3, revenueYen: 4_500 }),
    ).toEqual({ conversions: 3, revenueYen: 4_500 });
  });

  /** **承認待ちの案件がありうる。** 成果があって0円は通す */
  it('成果があって0円は通す', () => {
    expect(
      normalizeWeeklyResult({ conversions: 2, revenueYen: 0 }),
    ).toMatchObject({ conversions: 2, revenueYen: 0 });
  });

  /** **0件なのに報酬があるのは打ち間違い** */
  it('0件で報酬があれば落とす', () => {
    expect(
      codeOf(() => normalizeWeeklyResult({ conversions: 0, revenueYen: 100 })),
    ).toBe(WEEKLY_RESULT_ERROR_CODES.invalidInput);
  });

  it.each([[-1], [1.5]])('%s は落とす', (conversions) => {
    expect(
      codeOf(() => normalizeWeeklyResult({ conversions, revenueYen: 0 })),
    ).toBe(WEEKLY_RESULT_ERROR_CODES.invalidInput);
  });

  it.each([['3'], [null], [undefined], [Number.NaN]])(
    '%o は数字として受け付けない',
    (conversions) => {
      expect(
        codeOf(() => normalizeWeeklyResult({ conversions, revenueYen: 0 })),
      ).toBe(WEEKLY_RESULT_ERROR_CODES.invalidInput);
    },
  );

  /** 打ち間違いを弾く */
  it('大きすぎる値を落とす', () => {
    expect(
      codeOf(() =>
        normalizeWeeklyResult({
          conversions: MAX_CONVERSIONS_PER_WEEK + 1,
          revenueYen: 0,
        }),
      ),
    ).toBe(WEEKLY_RESULT_ERROR_CODES.invalidInput);

    expect(
      codeOf(() =>
        normalizeWeeklyResult({
          conversions: 1,
          revenueYen: MAX_REVENUE_YEN_PER_WEEK + 1,
        }),
      ),
    ).toBe(WEEKLY_RESULT_ERROR_CODES.invalidInput);
  });
});

describe('週の区切り', () => {
  /** **JSTの月曜始まり。** 週の途中の日付だと同じ週で別の行になる */
  it('週の途中はその週の月曜になる', () => {
    // 2026-08-12 は水曜（JST）
    const wednesday = weekOf(new Date('2026-08-12T03:00:00.000Z'));
    const friday = weekOf(new Date('2026-08-14T03:00:00.000Z'));

    expect(wednesday).toBe(friday);
    expect(wednesday).toBe('2026-08-10');
  });

  /** **JSTで判定する。** UTCだと日曜の夜が前の週に入る */
  it('日曜の夜（JST）はその週のまま', () => {
    // JST 2026-08-16(日) 23:00 = UTC 2026-08-16 14:00
    expect(weekOf(new Date('2026-08-16T14:00:00.000Z'))).toBe('2026-08-10');
  });

  it('月曜になると次の週', () => {
    // JST 2026-08-17(月) 00:30 = UTC 2026-08-16 15:30
    expect(weekOf(new Date('2026-08-16T15:30:00.000Z'))).toBe('2026-08-17');
  });
});
