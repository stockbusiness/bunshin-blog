import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SnippetPage from '@/app/liff/blogs/[blogId]/snippet/page';
import { SnippetApiError, issueLinkSnippet } from '@/app/liff/_lib/snippet-api';

/**
 * `/liff/blogs/[blogId]/snippet` リンク計測を入れる（段10）。
 *
 * **`MANUAL.md` 段10 は「押すと保存されます」と書いていたが、
 * その押すものがどこにも無かった**（Q-048）。
 *
 * ここで見張るのは2つ。
 * - **押す前に「古いものが効かなくなる」と書いてある**
 * - **中身が画面に出る**（LINEの中のブラウザは保存が効かないことがある）
 */

const SNIPPET = '<?php\n// bunshin-go.php\ndefine("TOKEN", "xxx");\n';

vi.mock('@/app/liff/_lib/snippet-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/snippet-api')>();

  return { ...actual, issueLinkSnippet: vi.fn() };
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SnippetPage params={Promise.resolve({ blogId: 'blog-1' })} />
      </Suspense>,
    );
  });
}

beforeEach(() => {
  vi.mocked(issueLinkSnippet).mockResolvedValue(SNIPPET);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('受け取れる', () => {
  /**
   * **押す前に書く。** 押してから「古いのが効かなくなりました」と
   * 知らせても遅い
   */
  it('押す前に、古いファイルが効かなくなると書いてある', async () => {
    await renderPage();

    expect(screen.getByText(/効かなくなります/)).toBeVisible();
    expect(issueLinkSnippet).not.toHaveBeenCalled();
  });

  it('押すと中身が画面に出る', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );

    await waitFor(() => {
      expect(issueLinkSnippet).toHaveBeenCalledWith('blog-1');
    });

    expect(await screen.findByLabelText('bunshin-go.php の中身')).toHaveValue(
      SNIPPET,
    );
  });

  it('置き場所を書いてある', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );

    expect(await screen.findByText(/wp-content\/mu-plugins\//)).toBeVisible();
  });

  /** **もう一度は出せない。** DBにはハッシュしか無い */
  it('いまだけしか見られないと書いてある', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );

    expect(await screen.findByText(/見られるのはいまだけ/)).toBeVisible();
  });

  it('受け取ったあとは作り直しの文言になる', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );

    expect(
      await screen.findByRole('button', { name: 'もう一度作り直す' }),
    ).toBeVisible();
  });

  it('コピーできる', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const user = userEvent.setup();

    // **`userEvent.setup()` のあとで差し替える。** setup 自身が
    // `navigator.clipboard` を自前のものに置き換えるため
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );
    await user.click(await screen.findByRole('button', { name: 'コピーする' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SNIPPET);
    });

    expect(
      await screen.findByRole('button', { name: 'コピーしました' }),
    ).toBeVisible();

    vi.unstubAllGlobals();
  });

  /** **コピーが効かなくても中身は出ている。** 手で選べる */
  it('コピーに失敗しても中身は残る', async () => {
    const user = userEvent.setup();

    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });

    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );
    await user.click(await screen.findByRole('button', { name: 'コピーする' }));

    expect(await screen.findByText(/選んで写してください/)).toBeVisible();
    expect(screen.getByLabelText('bunshin-go.php の中身')).toHaveValue(SNIPPET);

    vi.unstubAllGlobals();
  });

  it('受け取れなければ理由を出す', async () => {
    vi.mocked(issueLinkSnippet).mockRejectedValue(
      new SnippetApiError(503, 'APP_BASE_URL が設定されていません'),
    );

    const user = userEvent.setup();
    await renderPage();

    await user.click(
      screen.getByRole('button', { name: 'リンク計測のファイルを受け取る' }),
    );

    expect(
      await screen.findByText('APP_BASE_URL が設定されていません'),
    ).toBeVisible();
  });
});
