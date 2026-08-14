import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WordpressPage from '@/app/liff/blogs/[blogId]/wordpress/page';
import {
  WordpressApiError,
  connectWordpress,
  fetchWordpressConnection,
  requestAuthorizeUrl,
  testWordpressConnection,
  type ConnectionTestResultJson,
  type WordpressConnectionJson,
} from '@/app/liff/_lib/wordpress-api';

/**
 * `/liff/blogs/[blogId]/wordpress` WordPress をつなぐ（段6）。
 *
 * **この住所は `authorized` の戻り先として既に使われていた。**
 * 承認から戻ると `?authorize=connected` 付きでここへ転送されるのに、
 * **画面が存在しなかった**（Q-048）。
 *
 * 段6の済みは `connectionStatus === 'CONNECTED'` で、**接続テストを
 * 通って初めてそうなる。** 繋いだ直後に「終わり」と出さないことを見張る。
 */

const searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));

vi.mock('@/app/liff/_lib/wordpress-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/wordpress-api')>();

  return {
    ...actual,
    fetchWordpressConnection: vi.fn(),
    requestAuthorizeUrl: vi.fn(),
    connectWordpress: vi.fn(),
    testWordpressConnection: vi.fn(),
  };
});

function connection(
  overrides: Partial<WordpressConnectionJson> = {},
): WordpressConnectionJson {
  return {
    id: 'conn-1',
    blogId: 'blog-1',
    siteUrl: 'https://example.com',
    apiBaseUrl: 'https://example.com/wp-json',
    connectionStatus: 'UNTESTED',
    hasCredentials: true,
    canCreatePosts: false,
    canEditPosts: false,
    canUploadMedia: false,
    lastTestedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function testResult(
  overrides: Partial<ConnectionTestResultJson> = {},
): ConnectionTestResultJson {
  return {
    ok: true,
    checks: [
      { id: 'URL_FORMAT', status: 'PASSED', code: null, message: null },
      { id: 'REST_REACHABLE', status: 'PASSED', code: null, message: null },
      { id: 'AUTH', status: 'PASSED', code: null, message: null },
      { id: 'LIST_POSTS', status: 'PASSED', code: null, message: null },
      { id: 'CREATE_DRAFT', status: 'PASSED', code: null, message: null },
      { id: 'EDIT_POST', status: 'PASSED', code: null, message: null },
      { id: 'MEDIA', status: 'PASSED', code: null, message: null },
    ],
    canCreatePosts: true,
    canEditPosts: true,
    canUploadMedia: true,
    failedCode: null,
    failedMessage: null,
    leftoverPostId: null,
    ...overrides,
  };
}

/**
 * ページを描画する。
 *
 * **`await act` で包む。** App Router のページは `params`（Promise）を
 * `use()` で読むため、最初の描画で必ずサスペンドする（`blog-settings`
 * のテストと同じ理由）。
 */
async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <WordpressPage params={Promise.resolve({ blogId: 'blog-1' })} />
      </Suspense>,
    );
  });
}

beforeEach(() => {
  searchParams.forEach((_value, key) => {
    searchParams.delete(key);
  });

  vi.mocked(fetchWordpressConnection).mockResolvedValue({ connection: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('まだ繋いでいないとき', () => {
  /** **承認画面を先に出す。** パスワードを人が写さずに済む */
  it('サイトURLを入れて承認へ進める', async () => {
    vi.mocked(requestAuthorizeUrl).mockResolvedValue({
      authorizeUrl: 'https://example.com/wp-admin/authorize-application.php',
    });

    const assign = vi.fn();
    vi.stubGlobal('location', { assign });

    const user = userEvent.setup();
    await renderPage();

    await user.type(
      await screen.findByLabelText('サイトのURL'),
      'https://example.com',
    );
    await user.click(
      screen.getByRole('button', { name: 'WordPress で承認する' }),
    );

    await waitFor(() => {
      expect(requestAuthorizeUrl).toHaveBeenCalledWith(
        'blog-1',
        'https://example.com',
      );
    });

    expect(assign).toHaveBeenCalledWith(
      'https://example.com/wp-admin/authorize-application.php',
    );

    vi.unstubAllGlobals();
  });

  it('URLが空のあいだは承認へ進めない', async () => {
    await renderPage();

    expect(
      await screen.findByRole('button', { name: 'WordPress で承認する' }),
    ).toBeDisabled();
  });

  /**
   * **手で貼る道は畳んでおく。** 先に見せると「32文字を写す作業」に
   * 見えて、そこで止まる。
   */
  it('手で貼る道は畳まれている', async () => {
    await renderPage();

    await screen.findByLabelText('サイトのURL');

    const details = screen
      .getByText('承認の画面が出ないとき')
      .closest('details');

    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
  });

  it('手で貼っても繋げる', async () => {
    vi.mocked(connectWordpress).mockResolvedValue({
      connection: connection(),
    });

    const user = userEvent.setup();
    await renderPage();

    await user.type(
      await screen.findByLabelText('サイトのURL'),
      'https://example.com',
    );
    await user.type(screen.getByLabelText('WordPress のユーザー名'), 'admin');
    await user.type(
      screen.getByLabelText('アプリケーションパスワード'),
      'abcd efgh ijkl',
    );
    await user.click(screen.getByRole('button', { name: '貼り付けてつなぐ' }));

    await waitFor(() => {
      expect(connectWordpress).toHaveBeenCalledWith('blog-1', {
        siteUrl: 'https://example.com',
        wpUsername: 'admin',
        appPassword: 'abcd efgh ijkl',
      });
    });
  });
});

describe('繋いだ後', () => {
  beforeEach(() => {
    vi.mocked(fetchWordpressConnection).mockResolvedValue({
      connection: connection(),
    });
  });

  /** **繋いだだけでは段6は済まない**（`CONNECTED` は接続テストが付ける） */
  it('試していなければ、済んでいないと書く', async () => {
    await renderPage();

    expect(await screen.findByText(/まだ確かめていません/)).toBeVisible();
  });

  it('確かめてあれば、済んでいると書く', async () => {
    vi.mocked(fetchWordpressConnection).mockResolvedValue({
      connection: connection({ connectionStatus: 'CONNECTED' }),
    });

    await renderPage();

    expect(await screen.findByText(/この段は済んでいます/)).toBeVisible();
  });

  /** **「接続できません」だけにしない。** 7項目のどこで止まったかを出す */
  it('接続テストの7項目を出す', async () => {
    vi.mocked(testWordpressConnection).mockResolvedValue({
      result: testResult({
        ok: false,
        checks: [
          { id: 'URL_FORMAT', status: 'PASSED', code: null, message: null },
          { id: 'REST_REACHABLE', status: 'PASSED', code: null, message: null },
          {
            id: 'AUTH',
            status: 'FAILED',
            code: 'AUTH_FAILED',
            message: 'ユーザー名かパスワードが違います',
          },
          { id: 'LIST_POSTS', status: 'SKIPPED', code: null, message: null },
          { id: 'CREATE_DRAFT', status: 'SKIPPED', code: null, message: null },
          { id: 'EDIT_POST', status: 'SKIPPED', code: null, message: null },
          { id: 'MEDIA', status: 'SKIPPED', code: null, message: null },
        ],
        failedCode: 'AUTH_FAILED',
        failedMessage: 'ユーザー名かパスワードが違います',
      }),
    });

    const user = userEvent.setup();
    await renderPage();

    await user.click(
      await screen.findByRole('button', { name: '接続をためす' }),
    );

    expect(await screen.findByText(/ログイン/)).toBeVisible();
    expect(screen.getByText(/ユーザー名かパスワードが違います/)).toBeVisible();
    expect(screen.getByText('通らなかった項目があります')).toBeVisible();
  });

  /** **身に覚えのない下書きを黙って残さない** */
  it('消せなかったテスト投稿を知らせる', async () => {
    vi.mocked(testWordpressConnection).mockResolvedValue({
      result: testResult({ leftoverPostId: 42 }),
    });

    const user = userEvent.setup();
    await renderPage();

    await user.click(
      await screen.findByRole('button', { name: '接続をためす' }),
    );

    expect(
      await screen.findByText(/テスト用の下書きが消せませんでした/),
    ).toBeVisible();
  });

  it('試して失敗したら理由を出す', async () => {
    vi.mocked(testWordpressConnection).mockRejectedValue(
      new WordpressApiError(404, 'ブログが見つかりません'),
    );

    const user = userEvent.setup();
    await renderPage();

    await user.click(
      await screen.findByRole('button', { name: '接続をためす' }),
    );

    expect(await screen.findByText('ブログが見つかりません')).toBeVisible();
  });
});

/**
 * **承認から戻ったときの結果を伝える。** 何も出さないと、
 * 承認したのに何が起きたのか分からない。
 */
describe('承認から戻ったとき', () => {
  it('繋がったら、次に試すよう伝える', async () => {
    searchParams.set('authorize', 'connected');
    vi.mocked(fetchWordpressConnection).mockResolvedValue({
      connection: connection(),
    });

    await renderPage();

    expect(
      await screen.findByText(/WordPress との接続を保存しました/),
    ).toBeVisible();
  });

  /** **取り消しは失敗ではない。** 押し間違いとして扱う */
  it('取り消したら、やり直せると伝える', async () => {
    searchParams.set('authorize', 'rejected');

    await renderPage();

    expect(await screen.findByText(/承認が取り消されました/)).toBeVisible();
  });
});
