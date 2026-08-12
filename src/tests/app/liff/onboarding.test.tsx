import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from '@/app/liff/onboarding/page';
import {
  fetchOnboarding,
  type OnboardingProgressJson,
  type OnboardingStep,
} from '@/app/liff/_lib/onboarding-api';

/**
 * はじめの設定（TASKS H-2a）の描画（TASKS B-9）。
 *
 * 完了条件の「中断・再開ができる」は、**画面が状態を持たないこと**で
 * 成り立つ。ここで確かめるのは、サーバーが返した現在地をそのまま出すか。
 */

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
  const steps = STEPS.map((step, index) => ({
    step,
    done: index < doneUpTo,
    current: index === doneUpTo,
  }));

  return {
    steps,
    currentStep: STEPS[doneUpTo] ?? null,
    completed: doneUpTo >= STEPS.length,
    doneCount: doneUpTo,
    totalCount: STEPS.length,
    status: doneUpTo >= STEPS.length ? 'COMPLETED' : 'IN_PROGRESS',
  };
}

beforeEach(() => {
  vi.mocked(fetchOnboarding).mockResolvedValue(progress(3));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('はじめの設定', () => {
  it('件数と段の名前を出す', async () => {
    render(<OnboardingPage />);

    expect(await screen.findByText('3 / 10 件')).toBeInTheDocument();
    expect(screen.getByText('分身をつくる')).toBeInTheDocument();
    expect(screen.getByText('リンク計測を入れる')).toBeInTheDocument();
  });

  /** **いまここが分かること**が中断・再開の要 */
  it('いまの段に aria-current を付ける', async () => {
    render(<OnboardingPage />);

    const current = await screen.findByRole('listitem', { current: 'step' });

    expect(current).toHaveTextContent('分身をつくる');
    expect(current).toHaveTextContent('いまここ');
  });

  it('中断しても続けられることを書く', async () => {
    render(<OnboardingPage />);

    expect(
      await screen.findByText(/次に開いたときは、ここから続けられます/),
    ).toBeInTheDocument();
  });

  /** **済んだ段も開ける。** 直すために最初からやり直させない */
  it('済んだ段には「見直す」を出す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(5));

    render(<OnboardingPage />);

    expect(await screen.findAllByText('見直す')).not.toHaveLength(0);
  });

  /** H-2b で同意と通知の画面ができ、**行き先の無い段は残り1つ** */
  it('同意と通知には行き先がある', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(1));

    render(<OnboardingPage />);

    const terms = (await screen.findByText('利用規約に同意する')).closest('li');
    const notification = screen
      .getByText('通知の曜日と時刻を決める')
      .closest('li');

    expect(terms?.querySelector('a')).toHaveAttribute(
      'href',
      '/liff/onboarding/consent',
    );
    expect(notification?.querySelector('a')).toHaveAttribute(
      'href',
      '/liff/onboarding/notification',
    );
  });

  /**
   * **`LINE_LOGIN` には行き先が要らない。** この画面が見えている時点で
   * 済んでいるので、押せないボタンも「まだありません」も出さない
   */
  it('LINEログインの段にはリンクを出さない', async () => {
    render(<OnboardingPage />);

    const item = (await screen.findByText('LINEでログイン')).closest('li');

    expect(item?.querySelector('a')).toBeNull();
    expect(item).toHaveTextContent('済み');
  });

  it('全部済んでいれば、そう伝える', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(10));

    render(<OnboardingPage />);

    expect(
      await screen.findByText(/設定はすべて終わっています/),
    ).toBeInTheDocument();
  });

  it('読み込みに失敗したらサーバーの文言を出す', async () => {
    vi.mocked(fetchOnboarding).mockRejectedValue(new Error('boom'));

    render(<OnboardingPage />);

    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument();
  });
});
