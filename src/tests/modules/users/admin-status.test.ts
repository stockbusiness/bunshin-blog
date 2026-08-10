import { describe, expect, it } from 'vitest';
import { canApplyMonitorAction, isMonitorAdminAction } from '@/modules/users';

/**
 * モニターの状態を変える操作の判定（TASKS H-1、SPEC 6.2）。
 *
 * **表にして1箇所に置く**理由を確かめる — 条件分岐に散らすと
 * 「停止中を承認できてしまう」ような穴が後から入る。
 */

describe('その状態で意味のある操作か', () => {
  it.each([
    ['INVITED', 'ACTIVATE', true],
    ['INVITED', 'PAUSE', false],
    ['INVITED', 'RESUME', false],
    ['ACTIVE', 'PAUSE', true],
    ['ACTIVE', 'ACTIVATE', true],
    ['PAUSED', 'RESUME', true],
    ['PAUSED', 'ACTIVATE', false],
    ['PAUSED', 'PAUSE', true],
    ['WITHDRAWN', 'ACTIVATE', false],
    ['WITHDRAWN', 'RESUME', false],
    ['WITHDRAWN', 'PAUSE', false],
  ] as const)('%s に %s → %s', (status, action, expected) => {
    expect(canApplyMonitorAction({ action, status })).toBe(expected);
  });

  /** **認めるのは `ACTIVATE` だけ。** 停止の解除で参加を認めない */
  it('INVITED を RESUME で通さない', () => {
    expect(canApplyMonitorAction({ action: 'RESUME', status: 'INVITED' })).toBe(
      false,
    );
  });

  /** **退会は戻せない**（H-4 が扱う） */
  it('WITHDRAWN には何もできない', () => {
    for (const action of ['ACTIVATE', 'PAUSE', 'RESUME'] as const) {
      expect(canApplyMonitorAction({ action, status: 'WITHDRAWN' })).toBe(
        false,
      );
    }
  });
});

describe('操作の名前', () => {
  it.each([['ACTIVATE'], ['PAUSE'], ['RESUME']])('%s を通す', (value) => {
    expect(isMonitorAdminAction(value)).toBe(true);
  });

  it.each([['WITHDRAW'], ['activate'], [''], [null], [1]])(
    '%o を拒否する',
    (value) => {
      expect(isMonitorAdminAction(value)).toBe(false);
    },
  );
});
