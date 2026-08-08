import { describe, expect, it } from 'vitest';
import {
  BUDGET_THRESHOLDS,
  buildBudgetAlert,
  crossedThresholds,
  readBudgetLimits,
  shouldDowngradeModel,
  shouldStopGeneration,
} from '@/modules/ai-costs';

/**
 * 予算の判定（TASKS E-15、SPEC 12.2）。
 *
 * 完了条件は「**超過しても生成が停止しない。ADMINへ通知される**」。
 */

function cross(before: number, after: number, limitUsd: number | null = 10) {
  return crossedThresholds({
    scope: 'USER',
    limitUsd,
    costBeforeUsd: before,
    costAfterUsd: after,
  });
}

describe('crossedThresholds', () => {
  it('80% を跨いだら通知する', () => {
    expect(cross(7.8, 8.2).map((entry) => entry.threshold)).toEqual([0.8]);
  });

  /** 超えている間ずっと鳴らすと、AI呼び出しのたびにメールが飛ぶ */
  it('跨いでいなければ通知しない', () => {
    expect(cross(8.2, 8.5)).toEqual([]);
    expect(cross(1, 2)).toEqual([]);
  });

  it('一度に複数の境目を跨いだら全て返す', () => {
    expect(cross(9.5, 16).map((entry) => entry.threshold)).toEqual([1.0, 1.5]);
  });

  it('ちょうど境目に達したら跨いだとみなす', () => {
    expect(cross(7.9, 8).map((entry) => entry.threshold)).toEqual([0.8]);
  });

  it('同じ額で2回呼ばれても2回目は跨がない', () => {
    expect(cross(8, 8)).toEqual([]);
  });

  it('全ての境目を1回の記録で跨げる', () => {
    expect(cross(0, 20).map((entry) => entry.threshold)).toEqual([
      ...BUDGET_THRESHOLDS,
    ]);
  });

  /** **0を上限として扱わない。** 最初の1回で全ての境目を跨ぐ */
  it.each([[null], [0], [-1]])('上限が %o なら鳴らさない', (limitUsd) => {
    expect(cross(0, 100, limitUsd)).toEqual([]);
  });

  it('上限と現在額を結果に含める', () => {
    const [entry] = cross(7.8, 8.2);

    expect(entry).toMatchObject({
      scope: 'USER',
      threshold: 0.8,
      limitUsd: 10,
      costUsd: 8.2,
    });
  });
});

describe('readBudgetLimits', () => {
  it('未設定なら null', () => {
    const limits = readBudgetLimits({});

    expect(limits.userMonthlyUsd).toBeNull();
    expect(limits.blogMonthlyUsd).toBeNull();
  });

  it('環境変数から読む', () => {
    const limits = readBudgetLimits({
      AI_BUDGET_USER_MONTHLY_USD: '12.5',
      AI_BUDGET_BLOG_MONTHLY_USD: '4',
    });

    expect(limits.userMonthlyUsd).toBe(12.5);
    expect(limits.blogMonthlyUsd).toBe(4);
  });

  it.each([['0'], ['-1'], ['abc'], ['   ']])(
    '不正な値 %o は未設定として扱う',
    (value) => {
      expect(
        readBudgetLimits({ AI_BUDGET_USER_MONTHLY_USD: value }).userMonthlyUsd,
      ).toBeNull();
    },
  );

  /** **既定は無効**（SPEC 12.2） */
  it('停止と切替の既定は無効', () => {
    const limits = readBudgetLimits({});

    expect(limits.stopOnExceeded).toBe(false);
    expect(limits.downgradeOnExceeded).toBe(false);
  });

  it('true のときだけ有効になる', () => {
    expect(
      readBudgetLimits({ AI_BUDGET_STOP_ON_EXCEEDED: 'true' }).stopOnExceeded,
    ).toBe(true);
  });

  // 曖昧な値で止まると原因が分かりにくい
  it.each([['1'], ['yes'], ['TRUE '], ['on']])(
    '%o では有効にしない',
    (value) => {
      expect(
        readBudgetLimits({ AI_BUDGET_STOP_ON_EXCEEDED: value }).stopOnExceeded,
      ).toBe(value.trim().toLowerCase() === 'true');
    },
  );
});

describe('生成を止めない（完了条件）', () => {
  const limits = readBudgetLimits({ AI_BUDGET_USER_MONTHLY_USD: '10' });

  /**
   * **これが完了条件の半分。** Phase 0 で止めるとデータが欠落する
   * （SPEC 12.2）。
   */
  it.each([[0], [9.99], [10], [100], [1000]])(
    '費用 %s でも既定では止めない',
    (costUsd) => {
      expect(shouldStopGeneration({ limits, costUsd })).toBe(false);
      expect(shouldDowngradeModel({ limits, costUsd })).toBe(false);
    },
  );

  /** 仕組みは用意しておく（SPEC 12.2「実装するが既定値を無効とする」） */
  it('明示的に有効化すれば止まる', () => {
    const enabled = readBudgetLimits({
      AI_BUDGET_USER_MONTHLY_USD: '10',
      AI_BUDGET_STOP_ON_EXCEEDED: 'true',
    });

    expect(shouldStopGeneration({ limits: enabled, costUsd: 10 })).toBe(true);
    expect(shouldStopGeneration({ limits: enabled, costUsd: 9.99 })).toBe(
      false,
    );
  });

  it('有効化しても上限が無ければ止めない', () => {
    const enabled = readBudgetLimits({ AI_BUDGET_STOP_ON_EXCEEDED: 'true' });

    expect(shouldStopGeneration({ limits: enabled, costUsd: 1000 })).toBe(
      false,
    );
  });
});

describe('buildBudgetAlert', () => {
  const crossing = {
    scope: 'USER' as const,
    threshold: 0.8 as const,
    limitUsd: 10,
    costUsd: 8.25,
  };

  it('割合と金額を本文に入れる', () => {
    const alert = buildBudgetAlert(crossing);

    expect(alert.subject).toContain('80%');
    expect(alert.text).toContain('$10.00');
    expect(alert.text).toContain('$8.2500');
  });

  /**
   * **止まっていないことを明記する。** 受け取った側が「生成が止まった」と
   * 誤解して対応を急ぐのを防ぐ（SPEC 12.2）。
   */
  it('停止していないことを伝える', () => {
    expect(buildBudgetAlert(crossing).text).toContain('停止しません');
  });

  it('ユーザーとブログを区別する', () => {
    expect(buildBudgetAlert(crossing).subject).toContain('ユーザー');
    expect(buildBudgetAlert({ ...crossing, scope: 'BLOG' }).subject).toContain(
      'ブログ',
    );
  });
});
