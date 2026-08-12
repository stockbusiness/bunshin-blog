import { describe, expect, it } from 'vitest';
import {
  LOW_RESPONSE_RATE,
  MIN_SENT_FOR_JUDGEMENT,
  judgeApprovalActivity,
} from '@/modules/approvals';

/**
 * モニターの反応の判定（TASKS J-5）。
 *
 * **Phase 0 で最も起きやすい失敗は「モニターが承認しない」。**
 * 8週間継続率を待たずに、14日で気づくためのもの。
 */

describe('送っていない人を「反応が悪い」にしない', () => {
  /**
   * **直す相手が違う。** 提案が届いていないのは Bunshin 側の問題
   * （構成表・記事生成・通知のどこかが止まっている）
   */
  it('1件も送れていなければ NOTHING_SENT', () => {
    expect(judgeApprovalActivity({ sent: 0, responded: 0 })).toEqual({
      verdict: 'NOTHING_SENT',
      rate: null,
    });
  });

  /** **0% を返さない。**「押していない」と読めてしまう */
  it('割合を返さない', () => {
    expect(judgeApprovalActivity({ sent: 0, responded: 0 }).rate).toBeNull();
  });
});

describe('少ない件数で決めつけない', () => {
  it(`${MIN_SENT_FOR_JUDGEMENT}件未満なら判定しない`, () => {
    const judged = judgeApprovalActivity({
      sent: MIN_SENT_FOR_JUDGEMENT - 1,
      responded: 0,
    });

    expect(judged.verdict).toBe('NOT_ENOUGH_DATA');
    expect(judged.rate).toBeNull();
  });

  it(`${MIN_SENT_FOR_JUDGEMENT}件あれば判定する`, () => {
    expect(
      judgeApprovalActivity({ sent: MIN_SENT_FOR_JUDGEMENT, responded: 0 })
        .verdict,
    ).toBe('LOW_RESPONSE');
  });
});

describe('反応の具合', () => {
  it('半分以上に反応していれば ACTIVE', () => {
    expect(judgeApprovalActivity({ sent: 10, responded: 8 })).toEqual({
      verdict: 'ACTIVE',
      rate: 0.8,
    });
  });

  it('半分未満なら LOW_RESPONSE', () => {
    expect(judgeApprovalActivity({ sent: 10, responded: 2 })).toMatchObject({
      verdict: 'LOW_RESPONSE',
      rate: 0.2,
    });
  });

  /** ちょうど境目は「反応している」側に置く（**疑わしきは責めない**） */
  it('ちょうど境目なら ACTIVE', () => {
    expect(
      judgeApprovalActivity({ sent: 10, responded: LOW_RESPONSE_RATE * 10 })
        .verdict,
    ).toBe('ACTIVE');
  });

  it('全部に反応していれば 100%', () => {
    expect(judgeApprovalActivity({ sent: 5, responded: 5 }).rate).toBe(1);
  });
});
