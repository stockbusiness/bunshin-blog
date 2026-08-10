import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TABS,
  APPROVAL_TAB_LABELS,
  approvalStatusLabel,
  approvalTabOf,
  isOpenApproval,
} from '@/modules/approvals';

/**
 * 承認一覧の並べ分け（TASKS F-4、SPEC 6.1 `/liff/approvals`）。
 *
 * ```text
 * - 承認待ち / 承認済み / 修正依頼 / 見送り
 * ```
 */

describe('タブ（SPEC 6.1）', () => {
  it('4つある', () => {
    expect([...APPROVAL_TABS]).toEqual([
      'PENDING',
      'APPROVED',
      'REVISION_REQUESTED',
      'SKIPPED',
    ]);
  });

  it('すべてに名前がある', () => {
    for (const tab of APPROVAL_TABS) {
      expect(APPROVAL_TAB_LABELS[tab].length).toBeGreaterThan(0);
    }
  });
});

describe('状態からタブを決める', () => {
  it.each([
    ['PENDING', 'PENDING'],
    ['APPROVED', 'APPROVED'],
    ['REVISION_REQUESTED', 'REVISION_REQUESTED'],
    ['SKIPPED', 'SKIPPED'],
  ])('%s → %s', (status, expected) => {
    expect(approvalTabOf(status)).toBe(expected);
  });

  /**
   * **開いただけで一覧から消えない。**「あとで答えよう」と閉じた提案を
   * 見つけられなくなる
   */
  it('VIEWED は承認待ちに残る', () => {
    expect(approvalTabOf('VIEWED')).toBe('PENDING');
  });

  /** **どこにも置かないと画面から消える。** SPEC の4つには無い状態 */
  it('EXPIRED は見送りに入れる', () => {
    expect(approvalTabOf('EXPIRED')).toBe('SKIPPED');
  });

  /** **消えるより「見送り」に出るほうがまだ気づける** */
  it('知らない状態も見送りに落とす', () => {
    expect(approvalTabOf('SOMETHING_NEW')).toBe('SKIPPED');
  });
});

describe('行に出す状態の名前', () => {
  /**
   * **タブより細かい。**「自分で見送った」と「期限が切れた」を
   * 同じに見せると、判断の記録として使えない
   */
  it('見送りと期限切れを区別する', () => {
    expect(approvalStatusLabel('SKIPPED')).toBe('見送り');
    expect(approvalStatusLabel('EXPIRED')).toBe('期限切れ');
  });

  it('未読と確認中を区別する', () => {
    expect(approvalStatusLabel('PENDING')).toBe('未読');
    expect(approvalStatusLabel('VIEWED')).toBe('確認中');
  });

  it('知らない値はそのまま返す', () => {
    expect(approvalStatusLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('返事がまだか', () => {
  it.each([
    ['PENDING', true],
    ['VIEWED', true],
    ['APPROVED', false],
    ['SKIPPED', false],
    ['EXPIRED', false],
  ])('%s → %s', (status, expected) => {
    expect(isOpenApproval(status)).toBe(expected);
  });
});
