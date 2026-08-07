import { describe, expect, it } from 'vitest';
import { EMPTY_BLOG_COUNT, toBlogCounts } from '@/modules/blogs';

/**
 * 管理画面向けのブログ数集計（TASKS B-7）。
 *
 * DBの問い合わせ結果をどうまとめるかだけを見る。実際に集計できているかは
 * `src/tests/integration/admin-users.test.ts` が実PostgreSQLで確認する。
 */

describe('toBlogCounts', () => {
  it('行が無ければ空', () => {
    expect(toBlogCounts([])).toEqual({});
  });

  it('稼働中を数える', () => {
    const counts = toBlogCounts([{ userId: 'u1', status: 'ACTIVE', count: 2 }]);

    expect(counts['u1']).toEqual({ open: 2, closed: 0, usedSlots: 2 });
  });

  it.each(['SETUP', 'ACTIVE', 'PAUSED'])('%s は稼働側で数える', (status) => {
    const counts = toBlogCounts([{ userId: 'u1', status, count: 1 }]);

    expect(counts['u1']?.open).toBe(1);
    expect(counts['u1']?.closed).toBe(0);
  });

  it('CLOSED は分けて数える', () => {
    const counts = toBlogCounts([{ userId: 'u1', status: 'CLOSED', count: 1 }]);

    expect(counts['u1']).toEqual({ open: 0, closed: 1, usedSlots: 1 });
  });

  it('CLOSED も使用枠に含める（Q-008）', () => {
    // 閉じてもスロットは戻らない。稼働数だけを見ると
    // 「まだ枠が空いている」と誤読される
    const counts = toBlogCounts([
      { userId: 'u1', status: 'ACTIVE', count: 1 },
      { userId: 'u1', status: 'CLOSED', count: 2 },
    ]);

    expect(counts['u1']).toEqual({ open: 1, closed: 2, usedSlots: 3 });
  });

  it('複数の状態を1人分にまとめる', () => {
    const counts = toBlogCounts([
      { userId: 'u1', status: 'SETUP', count: 1 },
      { userId: 'u1', status: 'ACTIVE', count: 1 },
      { userId: 'u1', status: 'PAUSED', count: 1 },
    ]);

    expect(counts['u1']).toEqual({ open: 3, closed: 0, usedSlots: 3 });
  });

  it('ユーザーを混ぜない', () => {
    const counts = toBlogCounts([
      { userId: 'u1', status: 'ACTIVE', count: 2 },
      { userId: 'u2', status: 'ACTIVE', count: 1 },
      { userId: 'u2', status: 'CLOSED', count: 1 },
    ]);

    expect(counts['u1']).toEqual({ open: 2, closed: 0, usedSlots: 2 });
    expect(counts['u2']).toEqual({ open: 1, closed: 1, usedSlots: 2 });
  });

  it('行の順序に依存しない', () => {
    const forward = toBlogCounts([
      { userId: 'u1', status: 'ACTIVE', count: 1 },
      { userId: 'u1', status: 'CLOSED', count: 1 },
    ]);
    const reversed = toBlogCounts([
      { userId: 'u1', status: 'CLOSED', count: 1 },
      { userId: 'u1', status: 'ACTIVE', count: 1 },
    ]);

    expect(forward).toEqual(reversed);
  });

  it('0件のユーザーは現れない。画面は既定値を使う', () => {
    const counts = toBlogCounts([{ userId: 'u1', status: 'ACTIVE', count: 1 }]);

    expect(counts['u2']).toBeUndefined();
    expect(counts['u2'] ?? EMPTY_BLOG_COUNT).toEqual({
      open: 0,
      closed: 0,
      usedSlots: 0,
    });
  });

  it('既定値を共有しない（1人目の集計が2人目に混ざらない）', () => {
    const counts = toBlogCounts([
      { userId: 'u1', status: 'ACTIVE', count: 1 },
      { userId: 'u2', status: 'ACTIVE', count: 1 },
    ]);

    expect(counts['u1']?.open).toBe(1);
    expect(counts['u2']?.open).toBe(1);
    expect(EMPTY_BLOG_COUNT).toEqual({ open: 0, closed: 0, usedSlots: 0 });
  });
});
