import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RichMenuEditor,
  buildAreas,
} from '@/app/admin/(protected)/rich-menu/_components/rich-menu-editor';
import {
  RichMenuApiError,
  applyRichMenu,
  fetchRichMenu,
  fetchRichMenuState,
  removeRemoteRichMenu,
  saveRichMenu,
  type RichMenuJson,
} from '@/app/admin/(protected)/rich-menu/_lib/rich-menu-api';

/**
 * リッチメニューの画面（Q-054、TASKS H-6）。
 *
 * 確かめるのは4点。
 *
 * 1. **保存とLINEへ出すが分かれている**（押すまで誰にも出ない）
 * 2. **画像と押す場所がそろうまで出せない**（LINEが受け取らない）
 * 3. **行き先を今の設定に入れ直せる** — LIFF IDが変わると
 *    全部のボタンが黙って壊れる。ここがこの画面の一番の理由
 * 4. **片づけ残りを黙って隠さない**
 */

vi.mock(
  '@/app/admin/(protected)/rich-menu/_lib/rich-menu-api',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/app/admin/(protected)/rich-menu/_lib/rich-menu-api')
      >();

    return {
      ...actual,
      fetchRichMenu: vi.fn(),
      saveRichMenu: vi.fn(),
      uploadRichMenuImage: vi.fn(),
      applyRichMenu: vi.fn(),
      fetchRichMenuState: vi.fn(),
      removeRemoteRichMenu: vi.fn(),
    };
  },
);

function menu(overrides: Partial<RichMenuJson> = {}): RichMenuJson {
  return {
    name: 'BUNSHIN BLOG',
    chatBarText: 'メニュー',
    canvas: 'LARGE',
    selected: true,
    areas: [
      {
        x: 0,
        y: 0,
        width: 1250,
        height: 843,
        label: 'はじめの設定',
        uri: 'https://liff.line.me/OLD-ID/onboarding',
      },
      {
        x: 1250,
        y: 0,
        width: 1250,
        height: 843,
        label: '提案を見る',
        uri: 'https://liff.line.me/OLD-ID/approvals',
      },
    ],
    hasImage: true,
    imageWidth: 2500,
    imageHeight: 1686,
    lineRichMenuId: null,
    appliedAt: null,
    ...overrides,
  };
}

const DESTINATIONS = [
  { label: 'はじめの設定', path: '/onboarding' },
  { label: '提案を見る', path: '/approvals' },
  { label: '今週の結果', path: '/results' },
  { label: 'ブログ', path: '/blogs' },
];

function loaded(
  overrides: Partial<RichMenuJson> = {},
  liffBaseUrl = 'https://liff.line.me/NEW-ID',
) {
  return {
    richMenu: menu(overrides),
    liffBaseUrl,
    destinations: DESTINATIONS,
  };
}

async function renderEditor(): Promise<void> {
  render(<RichMenuEditor />);

  await screen.findByRole('heading', { name: '1. 枠と文字' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchRichMenu).mockResolvedValue(loaded());
});

/**
 * **端数を最後の升へ寄せる。** 割り切れないまま並べると1pxの隙間ができ、
 * そこだけ押しても反応しない。
 */
describe('型から升目を作る', () => {
  it('3列でも隙間なく端まで届く', () => {
    const areas = buildAreas({ rows: 1, columns: 3 }, 'LARGE', []);

    expect(areas).toHaveLength(3);
    expect(areas[2]?.x ?? 0).toBe(1666);
    expect((areas[2]?.x ?? 0) + (areas[2]?.width ?? 0)).toBe(2500);
  });

  it('2段でも下まで届く', () => {
    const areas = buildAreas({ rows: 2, columns: 3 }, 'LARGE', []);

    expect(areas).toHaveLength(6);
    expect((areas[5]?.y ?? 0) + (areas[5]?.height ?? 0)).toBe(1686);
  });

  it('細い枠は高さ843になる', () => {
    const areas = buildAreas({ rows: 1, columns: 2 }, 'COMPACT', []);

    expect(areas[0]?.height).toBe(843);
  });

  /** **型だけ変えたいことがある。** 入れた名前と行き先は捨てない */
  it('入れてあった名前と行き先を引き継ぐ', () => {
    const areas = buildAreas({ rows: 1, columns: 2 }, 'LARGE', [
      {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        label: 'のこる',
        uri: 'https://example.com/a',
      },
    ]);

    expect(areas[0]?.label).toBe('のこる');
    expect(areas[0]?.uri).toBe('https://example.com/a');
    expect(areas[1]?.label).toBe('');
  });
});

describe('保存と適用を分けている', () => {
  /** **押すまで誰にも出ない** */
  it('保存してもLINEへは出ない', async () => {
    vi.mocked(saveRichMenu).mockResolvedValue({ richMenu: menu() });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(saveRichMenu).toHaveBeenCalledTimes(1);
    });

    expect(applyRichMenu).not.toHaveBeenCalled();
    expect(
      await screen.findByText('保存しました。まだLINEには出ていません'),
    ).toBeVisible();
  });

  it('LINEへ出すと適用される', async () => {
    vi.mocked(applyRichMenu).mockResolvedValue({
      applied: { lineRichMenuId: 'richmenu-1', staleRichMenuId: null },
    });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByRole('button', { name: 'LINEへ出す' }));

    expect(await screen.findByText('LINEへ出しました')).toBeVisible();
  });

  /** **片づけ残りを黙って隠さない** */
  it('古いメニューが残ったらそう言う', async () => {
    vi.mocked(applyRichMenu).mockResolvedValue({
      applied: {
        lineRichMenuId: 'richmenu-2',
        staleRichMenuId: 'richmenu-old',
      },
    });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByRole('button', { name: 'LINEへ出す' }));

    expect(await screen.findByText(/richmenu-old/)).toBeVisible();
  });
});

/** **画像のないメニューはLINEが受け取らない** */
describe('そろうまで出せない', () => {
  it('画像が無ければ「LINEへ出す」は押せない', async () => {
    vi.mocked(fetchRichMenu).mockResolvedValue(loaded({ hasImage: false }));

    await renderEditor();

    expect(screen.getByRole('button', { name: 'LINEへ出す' })).toBeDisabled();
  });

  it('押す場所が無ければ「LINEへ出す」は押せない', async () => {
    vi.mocked(fetchRichMenu).mockResolvedValue(loaded({ areas: [] }));

    await renderEditor();

    expect(screen.getByRole('button', { name: 'LINEへ出す' })).toBeDisabled();
  });

  /** **保存はいつでもできる。** 途中でやめられるようにする */
  it('そろっていなくても保存はできる', async () => {
    vi.mocked(fetchRichMenu).mockResolvedValue(loaded({ hasImage: false }));

    await renderEditor();

    expect(screen.getByRole('button', { name: '保存する' })).toBeEnabled();
  });
});

/**
 * **この画面の一番の理由。** LIFF ID が変わると、リッチメニューの
 * ボタンは全部が黙って壊れる（押しても何も起きない）。
 */
describe('行き先を今の設定に合わせる', () => {
  it('知っている画面のURLを入れ直す', async () => {
    vi.mocked(saveRichMenu).mockResolvedValue({ richMenu: menu() });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(
      screen.getByRole('button', { name: '行き先をいまの設定に合わせる' }),
    );
    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(saveRichMenu).toHaveBeenCalledTimes(1);
    });

    const sent = vi.mocked(saveRichMenu).mock.calls[0]?.[0];

    expect(sent?.areas[0]?.uri).toBe('https://liff.line.me/NEW-ID/onboarding');
    expect(sent?.areas[1]?.uri).toBe('https://liff.line.me/NEW-ID/approvals');
  });

  /** **知らないURLは触らない。** 勝手に書き換えるほうが危ない */
  it('外部のURLは書き換えない', async () => {
    vi.mocked(saveRichMenu).mockResolvedValue({ richMenu: menu() });
    vi.mocked(fetchRichMenu).mockResolvedValue(
      loaded({
        areas: [
          {
            x: 0,
            y: 0,
            width: 2500,
            height: 1686,
            label: 'お知らせ',
            uri: 'https://example.com/news',
          },
        ],
      }),
    );

    const user = userEvent.setup();
    await renderEditor();

    await user.click(
      screen.getByRole('button', { name: '行き先をいまの設定に合わせる' }),
    );
    await user.click(screen.getByRole('button', { name: '保存する' }));

    await waitFor(() => {
      expect(saveRichMenu).toHaveBeenCalledTimes(1);
    });

    expect(vi.mocked(saveRichMenu).mock.calls[0]?.[0].areas[0]?.uri).toBe(
      'https://example.com/news',
    );
  });

  /** **設定が無ければ、押せるふりをしない** */
  it('LIFFのURLが未設定なら、そう言って押させない', async () => {
    vi.mocked(fetchRichMenu).mockResolvedValue(loaded({}, ''));

    await renderEditor();

    expect(
      screen.queryByRole('button', { name: '行き先をいまの設定に合わせる' }),
    ).toBeNull();
    expect(screen.getByText(/LIFF のURLが設定されていません/)).toBeVisible();
  });
});

describe('いま出ているものを確かめる', () => {
  /** **保存した値ではなくLINEに聞く**（段6の「接続をためす」と同じ） */
  it('食い違っていたら、そう言う', async () => {
    vi.mocked(fetchRichMenuState).mockResolvedValue({
      state: {
        remote: [
          { richMenuId: 'richmenu-other', name: '別のもの', chatBarText: 'x' },
        ],
        defaultRichMenuId: 'richmenu-other',
        applied: false,
      },
    });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(
      screen.getByRole('button', { name: 'いま出ているものを確かめる' }),
    );

    expect(
      await screen.findByText(/保存してあるものと、いま出ているものが違います/),
    ).toBeVisible();
  });

  /** **出ているものは消せない。** 消すと誰にもメニューが出なくなる */
  it('全員に出ているものには「消す」を出さない', async () => {
    vi.mocked(fetchRichMenuState).mockResolvedValue({
      state: {
        remote: [
          {
            richMenuId: 'richmenu-live',
            name: 'いま出ている',
            chatBarText: 'x',
          },
        ],
        defaultRichMenuId: 'richmenu-live',
        applied: true,
      },
    });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(
      screen.getByRole('button', { name: 'いま出ているものを確かめる' }),
    );

    expect(await screen.findByText('全員に出ています')).toBeVisible();
    expect(screen.queryByRole('button', { name: '消す' })).toBeNull();
  });

  it('出ていないものは消せる', async () => {
    vi.mocked(fetchRichMenuState).mockResolvedValue({
      state: {
        remote: [
          { richMenuId: 'richmenu-old', name: '古い', chatBarText: 'x' },
        ],
        defaultRichMenuId: 'richmenu-live',
        applied: false,
      },
    });
    vi.mocked(removeRemoteRichMenu).mockResolvedValue({
      removed: 'richmenu-old',
    });

    const user = userEvent.setup();
    await renderEditor();

    await user.click(
      screen.getByRole('button', { name: 'いま出ているものを確かめる' }),
    );
    await user.click(await screen.findByRole('button', { name: '消す' }));

    await waitFor(() => {
      expect(removeRemoteRichMenu).toHaveBeenCalledWith('richmenu-old');
    });
  });
});

describe('うまくいかないとき', () => {
  it('断られた理由をそのまま出す', async () => {
    vi.mocked(applyRichMenu).mockRejectedValue(
      new RichMenuApiError(400, '画像がありません。先に画像を上げてください'),
    );

    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByRole('button', { name: 'LINEへ出す' }));

    expect(
      await screen.findByText('画像がありません。先に画像を上げてください'),
    ).toBeVisible();
  });

  it('読み込めなければ、そう言う', async () => {
    vi.mocked(fetchRichMenu).mockRejectedValue(
      new RichMenuApiError(500, '読み込めませんでした'),
    );

    render(<RichMenuEditor />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '読み込めませんでした',
    );
  });
});
