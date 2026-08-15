import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from '@/app/liff/onboarding/page';
import { fetchBlogs, type BlogJson } from '@/app/liff/_lib/blogs-api';
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

vi.mock('@/app/liff/_lib/blogs-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/blogs-api')>();

  return { ...actual, fetchBlogs: vi.fn() };
});

const NO_BLOGS = {
  blogs: [] as BlogJson[],
  slots: { limit: 3, available: [1, 2, 3], remaining: 3 },
};

const ONE_BLOG = {
  blogs: [{ id: 'blog-1' } as BlogJson],
  slots: { limit: 3, available: [2, 3], remaining: 2 },
};

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
  vi.mocked(fetchBlogs).mockResolvedValue(NO_BLOGS);
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
   * **段5は一覧ではなく、作る画面を指す。**
   *
   * 元は `/liff/blogs` を指していた。その一覧には
   * 「オンボーディングから登録してください」と書いてあり、
   * **互いが相手を指していて段5を通せなかった**（実地で判明）。
   * 段5が塞がると段6以降へ一歩も進めない。
   */
  it('ブログの枠をつくる段は、作る画面を指す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(4));

    render(<OnboardingPage />);

    const blog = (await screen.findByText('ブログの枠をつくる')).closest('li');

    expect(blog?.querySelector('a')).toHaveAttribute('href', '/liff/blogs/new');
  });

  /**
   * **段6はそのブログの画面へ落とす。** `/liff/blogs`（一覧）のままだと、
   * 一覧→ブログ→設定→WordPress と辿ることになり、**どこにあるのか
   * 分からない。**
   */
  it('ブログが1つなら、WordPress の段はそのブログを指す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(5));
    vi.mocked(fetchBlogs).mockResolvedValue(ONE_BLOG);

    render(<OnboardingPage />);

    const item = (await screen.findByText('WordPress をつなぐ')).closest('li');

    await vi.waitFor(() => {
      expect(item?.querySelector('a')).toHaveAttribute(
        'href',
        '/liff/blogs/blog-1/wordpress',
      );
    });
  });

  it('ブログが1つなら、案件の段はそのブログを指す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(7));
    vi.mocked(fetchBlogs).mockResolvedValue(ONE_BLOG);

    render(<OnboardingPage />);

    const item = (await screen.findByText('案件を登録する')).closest('li');

    await vi.waitFor(() => {
      expect(item?.querySelector('a')).toHaveAttribute(
        'href',
        '/liff/blogs/blog-1/offers',
      );
    });
  });

  it('ブログが1つなら、ジャンルの段はそのブログを指す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(6));
    vi.mocked(fetchBlogs).mockResolvedValue(ONE_BLOG);

    render(<OnboardingPage />);

    const item = (await screen.findByText('ジャンルを決める')).closest('li');

    await vi.waitFor(() => {
      expect(item?.querySelector('a')).toHaveAttribute(
        'href',
        '/liff/blogs/blog-1/genre',
      );
    });
  });

  it('ブログが1つなら、リンク計測の段はそのブログを指す', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(9));
    vi.mocked(fetchBlogs).mockResolvedValue(ONE_BLOG);

    render(<OnboardingPage />);

    const item = (await screen.findByText('リンク計測を入れる')).closest('li');

    await vi.waitFor(() => {
      expect(item?.querySelector('a')).toHaveAttribute(
        'href',
        '/liff/blogs/blog-1/snippet',
      );
    });
  });

  /**
   * **2つ以上あるとき、どのブログの話かを画面が決めない。**
   * 勝手に決めると、別のブログを設定してしまう。
   */
  it('ブログが複数なら、WordPress の段は一覧のまま', async () => {
    vi.mocked(fetchOnboarding).mockResolvedValue(progress(5));
    vi.mocked(fetchBlogs).mockResolvedValue({
      blogs: [{ id: 'blog-1' } as BlogJson, { id: 'blog-2' } as BlogJson],
      slots: { limit: 3, available: [3], remaining: 1 },
    });

    render(<OnboardingPage />);

    const item = (await screen.findByText('WordPress をつなぐ')).closest('li');

    expect(item?.querySelector('a')).toHaveAttribute('href', '/liff/blogs');
  });

  /**
   * **ブログの取得に失敗しても10段は出す。** 行き先が一覧に戻るだけで、
   * ここで止めると設定そのものが見られなくなる。
   */
  it('ブログが読めなくても10段は出る', async () => {
    vi.mocked(fetchBlogs).mockRejectedValue(new Error('boom'));

    render(<OnboardingPage />);

    expect(await screen.findByText('分身をつくる')).toBeInTheDocument();
    expect(screen.getByText('WordPress をつなぐ')).toBeInTheDocument();
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
