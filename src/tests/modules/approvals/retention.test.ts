import { describe, expect, it } from 'vitest';
import {
  RETENTION_END_DAY,
  RETENTION_START_DAY,
  isRetentionEligible,
  retentionWindow,
  summarizeRetention,
  type RetentionEntry,
} from '@/modules/approvals';

/**
 * 8週間継続率（SPEC 16.2、Q-043。2026-08-17 の決定）。
 *
 * > **利用開始から43日目〜56日目の14日間に、承認・修正依頼・見送りの
 * > いずれかを1件以上行ったモニターを「継続」と定義する。**
 *
 * 守りたいのは3つ。
 *
 * 1. **日数の数え方をずらさない。** 1日ずれると、KPIが黙って別のものになる
 * 2. **8週間を過ぎていない人を分母に入れない**（まだ判定できない）
 * 3. **提案が届かなかった人を分母から外さない**（外すと障害が見えなくなる）
 */

const ACTIVATED = new Date('2026-01-01T00:00:00.000Z');
const DAY = 86_400_000;

function entry(overrides: Partial<RetentionEntry> = {}): RetentionEntry {
  return { userId: 'u1', sent: 4, decided: 2, ...overrides };
}

describe('判定期間', () => {
  /**
   * **利用開始日を1日目として数える。**
   * 43日目 = 開始から42日後。ここを1日ずらすと KPI が別物になる。
   */
  it('43日目に始まり、56日目の終わりまで', () => {
    const window = retentionWindow(ACTIVATED);

    expect(window.start.getTime()).toBe(ACTIVATED.getTime() + 42 * DAY);
    expect(window.endExclusive.getTime()).toBe(ACTIVATED.getTime() + 56 * DAY);
  });

  it('ちょうど14日間', () => {
    const window = retentionWindow(ACTIVATED);

    expect(window.endExclusive.getTime() - window.start.getTime()).toBe(
      14 * DAY,
    );
  });

  /** 定数と実際の窓が食い違わないこと */
  it('定数どおりの長さ', () => {
    expect(RETENTION_END_DAY - RETENTION_START_DAY + 1).toBe(14);
  });

  /**
   * **暦日へ丸めない。** 起点は利用者ごとに時刻が違うので、
   * 丸めると深夜に参加を認めた人だけ窓が1日ずれる。
   */
  it('起点の時刻をそのまま使う', () => {
    const evening = new Date('2026-01-01T23:30:00.000Z');

    expect(retentionWindow(evening).start.toISOString()).toBe(
      '2026-02-12T23:30:00.000Z',
    );
  });
});

/** **まだ判定できない人を「続かなかった」に入れない** */
describe('分母に入るか', () => {
  it('56日を過ぎていれば入る', () => {
    const now = new Date(ACTIVATED.getTime() + 56 * DAY);

    expect(isRetentionEligible(ACTIVATED, now)).toBe(true);
  });

  it('1秒でも足りなければ入らない', () => {
    const now = new Date(ACTIVATED.getTime() + 56 * DAY - 1_000);

    expect(isRetentionEligible(ACTIVATED, now)).toBe(false);
  });
});

describe('まとめる', () => {
  it('1件でも判断していれば継続', () => {
    const summary = summarizeRetention([
      entry({ userId: 'a', decided: 1 }),
      entry({ userId: 'b', decided: 0 }),
    ]);

    expect(summary).toMatchObject({ eligible: 2, continued: 1, rate: 0.5 });
  });

  /**
   * **0 も 100 も返さない。** 0 は「誰も続かなかった」、
   * 100 は「全員続いた」に見える（どちらも嘘）。
   */
  it('対象が0人なら率を出さない', () => {
    expect(summarizeRetention([]).rate).toBeNull();
  });

  /**
   * **提案が届かなかった人を分母から外さない。**
   * 外すと、ジョブ停止や通知障害による未活動が見えなくなる。
   */
  it('提案が届かなかった人も分母に入る', () => {
    const summary = summarizeRetention([
      entry({ userId: 'a', sent: 4, decided: 4 }),
      entry({ userId: 'b', sent: 0, decided: 0 }),
    ]);

    expect(summary.eligible).toBe(2);
    expect(summary.rate).toBe(0.5);
    expect(summary.noProposal).toBe(1);
  });

  /** **原因を分けるための数。** 届いた人だけで見た率 */
  it('届いた人だけの率を別に出す', () => {
    const summary = summarizeRetention([
      entry({ userId: 'a', sent: 4, decided: 4 }),
      entry({ userId: 'b', sent: 0, decided: 0 }),
    ]);

    expect(summary.respondedRateAmongSent).toBe(1);
  });

  it('誰にも届いていなければ、届いた人の率は出さない', () => {
    const summary = summarizeRetention([entry({ sent: 0, decided: 0 })]);

    expect(summary.respondedRateAmongSent).toBeNull();
  });
});
