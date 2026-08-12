import { Suspense } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogSettingsPage from '@/app/liff/blogs/[blogId]/settings/page';
import {
  BlogApiError,
  fetchBlog,
  saveBlogSettings,
  type BlogJson,
} from '@/app/liff/_lib/blogs-api';

/**
 * ブログ設定画面（TASKS B-5）の描画と保存（TASKS B-9）。
 *
 * **APIは差し替える。** ここで確かめたいのは画面の振る舞いであって、
 * サーバー側の判定ではない。判定は `src/tests/integration/blogs-settings.test.ts`
 * が実PostgreSQLで検証している。
 */

vi.mock('@/app/liff/_lib/blogs-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/blogs-api')>();

  return {
    ...actual,
    fetchBlog: vi.fn(),
    saveBlogSettings: vi.fn(),
  };
});

const BLOG: BlogJson = {
  id: 'blog-1',
  name: '節約ブログ',
  slug: 'setsuyaku',
  targetReader: '30代の会社員',
  penName: 'たろう',
  purpose: 'AFFILIATE',
  status: 'ACTIVE',
  slotNumber: 1,
  articleRatio: { revenue: 11, traffic: 19, weeklyPublishCap: 3 },
  genre: { id: 'genre-1', name: '一人暮らしの節約', category: '暮らし' },
};

/**
 * ページを描画する。
 *
 * **`await act` で包む。** App Router のページは `params`（Promise）を
 * `use()` で読むため、最初の描画で必ずサスペンドする。同期的に
 * `render()` すると fallback のまま止まり、要素が見つからない。
 */
async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <BlogSettingsPage params={Promise.resolve({ blogId: 'blog-1' })} />
      </Suspense>,
    );
  });
}

/** 画面が読み込みを終えるまで待つ */
async function renderLoaded() {
  await renderPage();
  await screen.findByRole('textbox', { name: 'ブログ名' });
}

beforeEach(() => {
  vi.mocked(fetchBlog).mockResolvedValue({ blog: BLOG, brokenLinks: [] });
  vi.mocked(saveBlogSettings).mockResolvedValue({ blog: BLOG });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('読み込み', () => {
  it('現在の値がフォームに入る', async () => {
    await renderLoaded();

    expect(screen.getByRole('textbox', { name: 'ブログ名' })).toHaveValue(
      '節約ブログ',
    );
    expect(screen.getByRole('textbox', { name: 'ペンネーム' })).toHaveValue(
      'たろう',
    );
    expect(screen.getByRole('textbox', { name: '想定読者' })).toHaveValue(
      '30代の会社員',
    );
    expect(screen.getByRole('combobox', { name: '収益方針' })).toHaveValue(
      'AFFILIATE',
    );
    expect(screen.getByRole('combobox', { name: '投稿頻度' })).toHaveValue('3');
  });

  it('読み込みに失敗すると理由を出す', async () => {
    vi.mocked(fetchBlog).mockRejectedValue(
      new BlogApiError(404, 'ブログが見つかりません'),
    );

    await renderPage();

    expect(await screen.findByText('ブログが見つかりません')).toBeVisible();
  });
});

describe('変更できない項目（Q-009・Q-011）', () => {
  it('ジャンルを表示する。入力欄にはしない', async () => {
    await renderLoaded();

    expect(screen.getByText('一人暮らしの節約')).toBeVisible();
    expect(
      screen.queryByRole('textbox', { name: 'ジャンル' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'ジャンル' }),
    ).not.toBeInTheDocument();
  });

  it('ジャンル未設定なら「未設定」と出す', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: { ...BLOG, genre: null },
      brokenLinks: [],
    });

    await renderLoaded();

    expect(screen.getByText('未設定')).toBeVisible();
  });

  it('記事の内訳を表示する。入力欄にはしない', async () => {
    await renderLoaded();

    expect(screen.getByText(/収益記事 11 本/)).toBeVisible();
    expect(screen.getByText(/集客記事 19 本/)).toBeVisible();
    expect(
      screen.queryByRole('spinbutton', { name: /収益記事/ }),
    ).not.toBeInTheDocument();
  });

  it('通知設定を置かない（Q-010）', async () => {
    await renderLoaded();

    expect(screen.queryByText(/通知/)).not.toBeInTheDocument();
  });

  /**
   * **0本を選べるようにしない**（Q-036）。公開の停止は G-8 の
   * 異常時の処理で、設定として選ぶものではない
   */
  it('投稿頻度は3〜5本しか選べない（SPEC 2.2・Q-036）', async () => {
    await renderLoaded();

    const options = screen.getAllByRole('option', { name: /^週 \d 本$/ });

    expect(options.map((option) => option.textContent)).toEqual([
      '週 3 本',
      '週 4 本',
      '週 5 本',
    ]);
  });

  /** **黙って選べる値へ丸めない。** 保存した覚えのない値になる */
  it('範囲の外の設定なら、そう書く', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: {
        ...BLOG,
        articleRatio: { ...BLOG.articleRatio, weeklyPublishCap: 0 },
      },
      brokenLinks: [],
    });

    await renderLoaded();

    expect(screen.getByText(/いまの設定は週/)).toBeVisible();
  });
});

describe('保存', () => {
  it('編集した内容を送る', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const name = screen.getByRole('textbox', { name: 'ブログ名' });
    await user.clear(name);
    await user.type(name, '新しい名前');
    await user.selectOptions(
      screen.getByRole('combobox', { name: '投稿頻度' }),
      '4',
    );
    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(saveBlogSettings).toHaveBeenCalledWith('blog-1', {
        name: '新しい名前',
        penName: 'たろう',
        targetReader: '30代の会社員',
        purpose: 'AFFILIATE',
        status: 'ACTIVE',
        weeklyPublishCap: 4,
      });
    });
  });

  it('算出値を送らない（Q-011）', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => expect(saveBlogSettings).toHaveBeenCalled());

    const [, payload] = vi.mocked(saveBlogSettings).mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty('revenue');
    expect(payload).not.toHaveProperty('traffic');
    expect(payload).not.toHaveProperty('genre');
    expect(payload).not.toHaveProperty('slug');
  });

  it('空のペンネームは null として送る', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.clear(screen.getByRole('textbox', { name: 'ペンネーム' }));
    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(saveBlogSettings).toHaveBeenCalledWith(
        'blog-1',
        expect.objectContaining({ penName: null }),
      );
    });
  });

  it('保存できたと伝える', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(await screen.findByText('保存しました')).toBeVisible();
  });

  it('保存に失敗するとサーバーの理由を出す', async () => {
    vi.mocked(saveBlogSettings).mockRejectedValue(
      new BlogApiError(422, '投稿頻度は週1〜4本で指定してください'),
    );
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(
      await screen.findByText('投稿頻度は週1〜4本で指定してください'),
    ).toBeVisible();
  });

  it('保存中はボタンを押せない', async () => {
    let resolve: (value: { blog: BlogJson }) => void = () => undefined;
    vi.mocked(saveBlogSettings).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: '保存する' }));

    const button = await screen.findByRole('button', {
      name: '保存しています',
    });
    expect(button).toBeDisabled();

    resolve({ blog: BLOG });
    await waitFor(() => expect(button).toBeEnabled());
  });
});

/**
 * いま切れているリンク（TASKS H-3b、SPEC 6.1「エラー」）。
 *
 * **いつから切れているか**が分からないと、モニターは直す優先度を決められない
 */
describe('リンク切れ', () => {
  const brokenLink = (overrides: Record<string, unknown> = {}) => ({
    offerId: 'offer-1',
    offerName: '格安SIM案件',
    brokenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  });

  it('切れている案件と、いつからかを出す', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: BLOG,
      brokenLinks: [brokenLink()],
    });

    await renderLoaded();

    expect(screen.getByText('格安SIM案件')).toBeVisible();
    expect(screen.getByText('（3日前から）')).toBeVisible();
  });

  it('今日切れたなら「今日から」', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: BLOG,
      brokenLinks: [brokenLink({ brokenAt: new Date().toISOString() })],
    });

    await renderLoaded();

    expect(screen.getByText('（今日から）')).toBeVisible();
  });

  /**
   * **「問題ありません」と書かない。** 確認できていない案件まで
   * 問題なしに見える（確認の結果が無いことと、確認して問題が無かったことは別）
   */
  it('切れていなければ何も出さない', async () => {
    await renderLoaded();

    expect(screen.queryByText(/リンクが切れています/)).not.toBeInTheDocument();
  });

  /** **「切れています」だけだと何をすればよいか分からない** */
  it('直し方を書く', async () => {
    vi.mocked(fetchBlog).mockResolvedValue({
      blog: BLOG,
      brokenLinks: [brokenLink()],
    });

    await renderLoaded();

    expect(screen.getByText(/ASPの管理画面でご確認/)).toBeVisible();
  });
});
