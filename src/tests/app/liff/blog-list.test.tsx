import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogListPage from '@/app/liff/blogs/page';
import {
  BlogApiError,
  fetchBlogs,
  type BlogJson,
  type BlogListJson,
} from '@/app/liff/_lib/blogs-api';

/**
 * ブログ一覧（TASKS B-5）の描画（TASKS B-9）。
 *
 * **残枠はサーバーの値を出しているか**を確かめる。`CLOSED` は一覧に
 * 出ないため、件数から空きを数えると実際とずれる（OPEN_QUESTIONS Q-008）。
 */

vi.mock('@/app/liff/_lib/blogs-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/blogs-api')>();

  return { ...actual, fetchBlogs: vi.fn() };
});

function blog(overrides: Partial<BlogJson> = {}): BlogJson {
  return {
    id: 'blog-1',
    name: '節約ブログ',
    slug: 'setsuyaku',
    targetReader: '30代の会社員',
    penName: null,
    purpose: 'AFFILIATE',
    status: 'ACTIVE',
    slotNumber: 1,
    articleRatio: { revenue: 7, traffic: 23, weeklyPublishCap: 4 },
    genre: null,
    ...overrides,
  };
}

function listJson(overrides: Partial<BlogListJson> = {}): BlogListJson {
  return {
    blogs: [blog()],
    slots: { limit: 3, available: [2, 3], remaining: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchBlogs).mockResolvedValue(listJson());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ブログ一覧', () => {
  it('ブログ名と状態を出す', async () => {
    render(<BlogListPage />);

    expect(await screen.findByText('節約ブログ')).toBeVisible();
    expect(screen.getByText(/稼働中/)).toBeVisible();
  });

  it('設定画面へのリンクを出す', async () => {
    render(<BlogListPage />);

    const link = await screen.findByRole('link', { name: '節約ブログ の設定' });

    expect(link).toHaveAttribute('href', '/liff/blogs/blog-1/settings');
  });

  it('残枠はサーバーの値を出す。件数から数えない（Q-008）', async () => {
    // 1件しか表示されないが、CLOSED が1件あるので空きは1枠
    vi.mocked(fetchBlogs).mockResolvedValue(
      listJson({ slots: { limit: 3, available: [3], remaining: 1 } }),
    );

    render(<BlogListPage />);

    expect(await screen.findByText(/あと 1 枠/)).toBeVisible();
  });

  it('ジャンル未設定と分かるように出す（Q-009）', async () => {
    render(<BlogListPage />);

    expect(await screen.findByText(/ジャンル未設定/)).toBeVisible();
  });

  it('1件も無いときは次にすることを書く', async () => {
    vi.mocked(fetchBlogs).mockResolvedValue(
      listJson({
        blogs: [],
        slots: { limit: 3, available: [1, 2, 3], remaining: 3 },
      }),
    );

    render(<BlogListPage />);

    expect(
      await screen.findByText(/オンボーディングから登録してください/),
    ).toBeVisible();
  });

  it('読み込みに失敗すると理由を出す', async () => {
    vi.mocked(fetchBlogs).mockRejectedValue(
      new BlogApiError(401, '認証が必要です'),
    );

    render(<BlogListPage />);

    expect(await screen.findByText('認証が必要です')).toBeVisible();
  });
});
