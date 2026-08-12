import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEPS,
  resolveOnboardingProgress,
  type OnboardingFacts,
} from '@/modules/users';

/**
 * オンボーディングの現在地（TASKS H-2a、SPEC 6.1、Q-035）。
 *
 * 完了条件は「**中断・再開ができる**」。**現在地を保存しない**ので、
 * ここで確かめるのは「同じ事実から同じ現在地が出るか」。
 */

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    lineLogin: true,
    termsAccepted: false,
    dataConsented: false,
    hasActivePersona: false,
    hasBlog: false,
    hasConnectedWordpress: false,
    hasGenre: false,
    hasOffer: false,
    hasNotificationSetting: false,
    hasLinkEventToken: false,
    ...overrides,
  };
}

const ALL_DONE: OnboardingFacts = {
  lineLogin: true,
  termsAccepted: true,
  dataConsented: true,
  hasActivePersona: true,
  hasBlog: true,
  hasConnectedWordpress: true,
  hasGenre: true,
  hasOffer: true,
  hasNotificationSetting: true,
  hasLinkEventToken: true,
};

describe('段の並び', () => {
  /** **段4は「分身を作る」**（Q-035）。目標は分身の `business` に含まれる */
  it('10段で、4番目が分身', () => {
    expect(ONBOARDING_STEPS).toHaveLength(10);
    expect(ONBOARDING_STEPS[3]).toBe('PERSONA');
  });

  it('スニペットの導入が段に入っている（Q-001 の再決定）', () => {
    expect(ONBOARDING_STEPS).toContain('SNIPPET');
  });
});

describe('現在地', () => {
  it('ログインだけなら、次は規約の同意', () => {
    const progress = resolveOnboardingProgress(facts());

    expect(progress.currentStep).toBe('TERMS');
    expect(progress.doneCount).toBe(1);
    expect(progress.completed).toBe(false);
  });

  it('同意まで済んでいれば、次は分身', () => {
    const progress = resolveOnboardingProgress(
      facts({ termsAccepted: true, dataConsented: true }),
    );

    expect(progress.currentStep).toBe('PERSONA');
  });

  it('全部済んでいれば現在地は無い', () => {
    const progress = resolveOnboardingProgress(ALL_DONE);

    expect(progress.completed).toBe(true);
    expect(progress.currentStep).toBeNull();
    expect(progress.doneCount).toBe(progress.totalCount);
  });

  /** **いまここは1つだけ。** 2つ光ると、どちらをやればよいか分からない */
  it('current は1つだけ', () => {
    const progress = resolveOnboardingProgress(
      facts({ termsAccepted: true, dataConsented: true }),
    );

    expect(progress.steps.filter((state) => state.current)).toHaveLength(1);
  });

  it('全部済んでいれば current はどこにも立たない', () => {
    expect(
      resolveOnboardingProgress(ALL_DONE).steps.filter((s) => s.current),
    ).toHaveLength(0);
  });
});

/**
 * **飛ばした段は未了のまま残す。** 順に埋めさせるより、抜けを見せるほうが
 * 直しやすい
 */
describe('飛ばした段', () => {
  it('先の段が済んでいても、抜けた段が現在地になる', () => {
    const progress = resolveOnboardingProgress(
      facts({
        termsAccepted: true,
        dataConsented: true,
        hasActivePersona: true,
        hasBlog: true,
        // WordPress を飛ばして案件だけ登録した
        hasOffer: true,
      }),
    );

    expect(progress.currentStep).toBe('WORDPRESS');
    // **飛ばした先の段は済みのまま**（やった事実は消さない）
    expect(progress.steps.find((state) => state.step === 'OFFER')?.done).toBe(
      true,
    );
  });
});

/**
 * **`LINE_LOGIN` だけ済んだ状態は「始まっていない」。**
 * ここへ来られる時点で必ず真なので、進捗として数えると
 * 全員が最初から「進行中」に見える
 */
describe('状態', () => {
  it.each([
    { name: 'ログインだけ', value: facts(), expected: 'NOT_STARTED' },
    {
      name: '規約に同意した',
      value: facts({ termsAccepted: true }),
      expected: 'IN_PROGRESS',
    },
    { name: '全部済み', value: ALL_DONE, expected: 'COMPLETED' },
  ])('$name → $expected', ({ value, expected }) => {
    expect(resolveOnboardingProgress(value).status).toBe(expected);
  });
});

/** **同じ事実からは同じ結果。** 中断・再開が成り立つ根拠 */
describe('中断・再開', () => {
  it('同じ事実を2回渡せば同じ現在地になる', () => {
    const input = facts({ termsAccepted: true, dataConsented: true });

    expect(resolveOnboardingProgress(input)).toEqual(
      resolveOnboardingProgress(input),
    );
  });
});
