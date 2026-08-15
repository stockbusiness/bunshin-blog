import { act, render, screen, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenrePage from '@/app/liff/blogs/[blogId]/genre/page';
import { fetchBlog, type BlogJson } from '@/app/liff/_lib/blogs-api';
import { fetchGenres, type GenreJson } from '@/app/liff/_lib/genres-api';
import { fetchOffers, type OfferJson } from '@/app/liff/_lib/offers-api';

/**
 * `/liff/blogs/[blogId]/genre` ジャンルを決める（段7）。
 *
 * **モニターはここで選ばない。** `ymyl_risk` は `genres` マスタの値で、
 * `HIGH` なら無条件で停止する。**自己申告にすると、停止条件を申告で
 * 回避できる**（Q-049）。
 *
 * ここで見張るのは3つ。
 *
 * - **選ぶ操作を置かない**（送信するものが無い）
 * - **案件0件のときに「先に案件を」と伝える**
 *   （`noOffers` は停止条件。伝えないと「希望を出したのに決まらない」が続く）
 * - **YMYL を隠さない**（なぜ選べないのかが見えているほうが移りやすい）
 */

vi.mock('@/app/liff/_lib/blogs-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/blogs-api')>();

  return { ...actual, fetchBlog: vi.fn() };
});

vi.mock('@/app/liff/_lib/genres-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/genres-api')>();

  return { ...actual, fetchGenres: vi.fn() };
});

vi.mock('@/app/liff/_lib/offers-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/offers-api')>();

  return { ...actual, fetchOffers: vi.fn() };
});

function blog(genre: BlogJson['genre'] = null): BlogJson {
  return {
    id: 'blog-1',
    name: 'ブログ',
    slug: 'blog',
    targetReader: '読者',
    penName: null,
    purpose: 'AFFILIATE',
    status: 'SETUP',
    slotNumber: 1,
    articleRatio: { revenue: 7, traffic: 23, weeklyPublishCap: 4 },
    genre,
  };
}

function genre(overrides: Partial<GenreJson> = {}): GenreJson {
  return {
    id: 'genre-1',
    name: '格安SIM',
    category: '通信',
    ymylRisk: 'LOW',
    status: 'CANDIDATE',
    ...overrides,
  };
}

function offer(overrides: Partial<OfferJson> = {}): OfferJson {
  return {
    id: 'offer-1',
    blogId: 'blog-1',
    name: '案件',
    aspName: 'ASP',
    advertiserName: null,
    landingPageUrl: 'https://lp.example.com',
    affiliateUrl: 'https://asp.example/click',
    rewardYen: null,
    conversionType: 'FREE_SIGNUP',
    userExperience: 'USED',
    userRating: null,
    denyConditions: [],
    status: 'ACTIVE',
    linkBrokenAt: null,
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <GenrePage params={Promise.resolve({ blogId: 'blog-1' })} />
      </Suspense>,
    );
  });
}

beforeEach(() => {
  vi.mocked(fetchBlog).mockResolvedValue({ blog: blog(), brokenLinks: [] });
  vi.mocked(fetchGenres).mockResolvedValue({ genres: [genre()] });
  vi.mocked(fetchOffers).mockResolvedValue({ offers: [offer()] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('モニターは選ばない', () => {
  /** **送信するものが無い。** 選ばせると、停止条件を申告で回避できる */
  it('選ぶ操作を置かない', async () => {
    await renderPage();

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('運営が決めると書いてある', async () => {
    await renderPage();

    expect(screen.getByText(/運営が確認して決めます/)).toBeVisible();
  });
});

describe('案件が要ることを伝える', () => {
  /**
   * **`noOffers` は停止条件。** 伝えないと「希望を出したのに決まらない」が
   * しばらく続く。
   */
  it('案件が0件なら、先に段8へ案内する', async () => {
    vi.mocked(fetchOffers).mockResolvedValue({ offers: [] });

    await renderPage();

    expect(screen.getByText(/審査は必ず止まります/)).toBeVisible();
    expect(
      screen.getByRole('link', { name: '案件を登録する' }),
    ).toHaveAttribute('href', '/liff/blogs/blog-1/offers');
  });

  /** **終了した案件は数えない**（審査も `ENDED` を除いて数える） */
  it('終了した案件しか無ければ0件として扱う', async () => {
    vi.mocked(fetchOffers).mockResolvedValue({
      offers: [offer({ status: 'ENDED' })],
    });

    await renderPage();

    expect(screen.getByText(/審査は必ず止まります/)).toBeVisible();
  });

  it('案件があれば件数を出して待つよう伝える', async () => {
    await renderPage();

    expect(screen.getByText(/案件が 1 件あります/)).toBeVisible();
  });
});

describe('候補の見せ方', () => {
  /** **隠さない。** なぜ選べないのかが見えているほうが移りやすい */
  it('YMYL は「選べない分野」として出す', async () => {
    vi.mocked(fetchGenres).mockResolvedValue({
      genres: [
        genre(),
        genre({ id: 'genre-2', name: '投資・資産運用', ymylRisk: 'HIGH' }),
      ],
    });

    await renderPage();

    expect(screen.getByText('選べない分野')).toBeVisible();
    expect(screen.getByText('投資・資産運用')).toBeVisible();
  });

  it('候補が無ければ、運営へ知らせるよう伝える', async () => {
    vi.mocked(fetchGenres).mockResolvedValue({ genres: [] });

    await renderPage();

    expect(screen.getByText(/運営が候補に足します/)).toBeVisible();
  });
});

describe('決まったあと', () => {
  it('決まっていれば、それを出して済みと伝える', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: blog({ id: 'genre-1', name: '格安SIM', category: '通信' }),
      brokenLinks: [],
    });

    await renderPage();

    const decided = screen.getByText('決まっています').closest('section');

    expect(decided).not.toBeNull();
    // **一覧にも同じ文字列が出る。** 決まった側だけを見る
    expect(
      within(decided as HTMLElement).getByText('通信／格安SIM'),
    ).toBeVisible();
  });
});
