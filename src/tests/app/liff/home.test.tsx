import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiffPage from '@/app/liff/page';
import { useLiffSession } from '@/app/liff/_components/liff-provider';
import {
  OnboardingApiError,
  fetchOnboarding,
  type OnboardingProgressJson,
  type OnboardingStep,
} from '@/app/liff/_lib/onboarding-api';

/**
 * `/liff` モニターの入口の描画。
 *
 * **LIFF のエンドポイントURLはこの画面を指している。** モニターが
 * LINE から開いて最初に見るのはここで、**ここに無い行き先は存在しない
 * のと同じ。**
 *
 * 元は接続確認画面（B-8）で、**リンクが1つも無かった。** 実地で通した
 * ところ、ログインは成功するのに**はじめの設定へ行けず詰まった。**
 * 二度と同じ形に戻らないよう、ここで見張る。
 */

vi.mock('@/app/liff/_components/liff-provider', () => ({
  useLiffSession: vi.fn(),
}));

vi.mock('@/app/liff/_lib/onboarding-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/onboarding-api')>();

  return { ...actual, fetchOnboarding: vi.fn() };
});

const STEPS: OnboardingStep[] = [
  'LINE_LOGIN',
  'TERMS',
  'DATA_CONSENT',
  'PERSONA',
  'BLOG',
  'WORDPRESS',
  'GENRE',
  'OFFER',
  'NOTIFICATION',
  'SNIPPET',
];

function progress(doneUpTo: number): OnboardingProgressJson {
  return {
    steps: STEPS.map((step, index) => ({
      step,
      done: index < doneUpTo,
      current: index === doneUpTo,
    })),
    currentStep: STEPS[doneUpTo] ?? null,
    completed: doneUpTo >= STEPS.length,
    doneCount: doneUpTo,
    totalCount: STEPS.length,
    status: doneUpTo >= STEPS.length ? 'COMPLETED' : 'IN_PROGRESS',
  };
}

beforeEach(() => {
  vi.mocked(useLiffSession).mockReturnValue({
    status: 'ready',
    user: { id: 'user-1', displayName: 'モニター', role: 'MONITOR' },
    consents: { completed: false, missing: ['terms', 'dataUse'] },
  } as unknown as ReturnType<typeof useLiffSession>);

  vi.mocked(fetchOnboarding).mockResolvedValue(progress(1));
});

afterEach(() => {
  vi.clearAllMocks();
});

/** **これが無いと、ログインした先が行き止まりになる** */
describe('はじめの設定へ行ける', () => {
  it('未完了なら残りの件数とともに出る', async () => {
    render(<LiffPage />);

    const link = await screen.findByRole('link', { name: /はじめの設定/ });

    expect(link).toHaveAttribute('href', '/liff/onboarding');
    expect(link).toHaveTextContent('あと 9 件');
  });

  /** **済んでも隠さない。** 直すために最初からやり直すことにならないように */
  it('完了しても見直せる', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(STEPS.length));

    render(<LiffPage />);

    const link = await screen.findByRole('link', { name: /はじめの設定/ });

    expect(link).toHaveAttribute('href', '/liff/onboarding');
  });

  /**
   * **通信が一度失敗しただけで、どこへも行けなくなるのを避ける。**
   * 入口だけは必ず描く。
   */
  it('進捗が読めなくても入口は出る', async () => {
    vi.mocked(fetchOnboarding).mockRejectedValue(
      new OnboardingApiError(0, '通信に失敗しました'),
    );

    render(<LiffPage />);

    expect(await screen.findByText('通信に失敗しました')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /はじめの設定/ })).toHaveAttribute(
      'href',
      '/liff/onboarding',
    );
  });
});

describe('設定が終わるまで、中身の無い画面を並べない', () => {
  /** **空の画面を開かせると「壊れている」に見える** */
  it('未完了なら提案やブログを出さない', async () => {
    render(<LiffPage />);

    await screen.findByRole('link', { name: /はじめの設定/ });

    expect(
      screen.queryByRole('link', { name: /届いている提案/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /ブログ/ }),
    ).not.toBeInTheDocument();
  });

  it('完了したら並ぶ', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(STEPS.length));

    render(<LiffPage />);

    expect(
      await screen.findByRole('link', { name: /届いている提案/ }),
    ).toHaveAttribute('href', '/liff/approvals');
    expect(screen.getByRole('link', { name: /ブログ/ })).toHaveAttribute(
      'href',
      '/liff/blogs',
    );
    expect(screen.getByRole('link', { name: /分身/ })).toHaveAttribute(
      'href',
      '/liff/personas',
    );
    expect(screen.getByRole('link', { name: /成果/ })).toHaveAttribute(
      'href',
      '/liff/results',
    );
  });
});

/**
 * **内部の識別子を利用者に見せない。**
 * 実地で `terms・dataUse` がそのまま出ていた。
 */
describe('内部の名前を出さない', () => {
  it('同意の項目名がそのまま出ていない', async () => {
    render(<LiffPage />);

    await screen.findByRole('link', { name: /はじめの設定/ });

    expect(screen.queryByText(/terms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dataUse/)).not.toBeInTheDocument();
  });
});
