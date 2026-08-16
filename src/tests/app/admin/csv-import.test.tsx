import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CsvImport,
  toBase64,
} from '@/app/admin/(protected)/offer-catalog/_components/csv-import';
import {
  CatalogApiError,
  previewImport,
  registerImported,
  type ImportPreviewJson,
} from '@/app/admin/(protected)/offer-catalog/_lib/catalog-api';

/**
 * ASPのCSVを取り込む画面（Q-056）。
 *
 * 確かめるのは3点。
 *
 * 1. **何件がどの理由で落ちたかを出す。** 黙って捨てると、
 *    「入れたはずの案件が無い」が起きる
 * 2. **列の対応を人が直せる。** ずれたまま取り込むと
 *    報酬額の欄に案件名が入る
 * 3. **選んだものだけを登録する**
 */

vi.mock(
  '@/app/admin/(protected)/offer-catalog/_lib/catalog-api',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/app/admin/(protected)/offer-catalog/_lib/catalog-api')
      >();

    return { ...actual, previewImport: vi.fn(), registerImported: vi.fn() };
  },
);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    rowNumber: 1,
    name: 'A社サービス',
    advertiserName: null,
    landingPageUrl: 'https://a.example.com/',
    rewardYen: 1_480,
    conversionType: 'FREE_SIGNUP' as const,
    denyConditions: [],
    status: 'ACTIVE',
    problem: null,
    ...overrides,
  };
}

function preview(
  overrides: Partial<ImportPreviewJson> = {},
): ImportPreviewJson {
  return {
    headers: ['案件名', '報酬', 'リンク先'],
    mapping: { name: 0, rewardYen: 1, landingPageUrl: 2 },
    kept: [candidate()],
    droppedByReason: {},
    totalRows: 1,
    droppedRows: 0,
    ...overrides,
  };
}

/** ファイルを選ぶところまで進める */
async function upload(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<CsvImport onRegistered={() => undefined} />);

  const file = new File(
    ['案件名,報酬,リンク先\nA,1480,https://a.test/'],
    'a.csv',
    {
      type: 'text/csv',
    },
  );

  await user.upload(screen.getByLabelText('CSVファイル'), file);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(previewImport).mockResolvedValue(preview());
});

describe('base64 にする', () => {
  it('大きくても壊れない', () => {
    const bytes = new Uint8Array(20_000).fill(65);

    expect(atob(toBase64(bytes.buffer)).length).toBe(20_000);
  });
});

describe('読み込んだあと', () => {
  it('残った件数を出す', async () => {
    vi.mocked(previewImport).mockResolvedValue(
      preview({ totalRows: 500, kept: [candidate()] }),
    );

    const user = userEvent.setup();
    await upload(user);

    expect(await screen.findByText(/1 件が残りました/)).toBeVisible();
    expect(screen.getByText(/500 行のうち/)).toBeVisible();
  });

  /** **黙って捨てない。** 「入れたはずの案件が無い」を防ぐ */
  it('落ちた理由と件数を出す', async () => {
    vi.mocked(previewImport).mockResolvedValue(
      preview({
        droppedByReason: { low_reward_purchase: 12, ended: 3 },
        totalRows: 16,
      }),
    );

    const user = userEvent.setup();
    await upload(user);

    expect(
      await screen.findByText(/購入型で報酬3,000円未満：12 件/),
    ).toBeVisible();
    expect(screen.getByText(/掲載終了・提携終了：3 件/)).toBeVisible();
  });

  /** **残らなかったのは、列の対応がずれている可能性が高い** */
  it('1件も残らなければ、列の対応を疑うよう伝える', async () => {
    vi.mocked(previewImport).mockResolvedValue(preview({ kept: [] }));

    const user = userEvent.setup();
    await upload(user);

    expect(await screen.findByText(/列の対応が合っているか/)).toBeVisible();
  });
});

/**
 * **AIの推測を直せる。** ずれたまま取り込むと報酬額の欄に案件名が入り、
 * 足切りが意味を失う。
 */
describe('列の対応を直す', () => {
  it('選び直して読み直せる', async () => {
    const user = userEvent.setup();
    await upload(user);

    await screen.findByText(/1 件が残りました/);
    await user.click(screen.getByText('列の対応を直す'));

    await user.selectOptions(screen.getByLabelText('報酬額'), '2');
    await user.click(
      screen.getByRole('button', { name: 'この対応で読み直す' }),
    );

    await waitFor(() => {
      expect(previewImport).toHaveBeenCalledTimes(2);
    });

    expect(vi.mocked(previewImport).mock.calls[1]?.[1]).toMatchObject({
      rewardYen: 2,
    });
  });

  it('使わない列にできる', async () => {
    const user = userEvent.setup();
    await upload(user);

    await screen.findByText(/1 件が残りました/);
    await user.click(screen.getByText('列の対応を直す'));

    await user.selectOptions(screen.getByLabelText('報酬額'), '');
    await user.click(
      screen.getByRole('button', { name: 'この対応で読み直す' }),
    );

    await waitFor(() => {
      expect(previewImport).toHaveBeenCalledTimes(2);
    });

    expect(vi.mocked(previewImport).mock.calls[1]?.[1]).not.toHaveProperty(
      'rewardYen',
    );
  });
});

describe('登録する', () => {
  /** **ASP名が無いと、どのASPの案件か分からなくなる** */
  it('ASPの名前が空のあいだは登録できない', async () => {
    const user = userEvent.setup();
    await upload(user);

    expect(
      await screen.findByRole('button', {
        name: /選んだ 1 件を下書きとして登録する/,
      }),
    ).toBeDisabled();
  });

  it('選んだものだけ送る', async () => {
    vi.mocked(previewImport).mockResolvedValue(
      preview({
        kept: [candidate(), candidate({ rowNumber: 2, name: 'B社サービス' })],
        totalRows: 2,
      }),
    );
    vi.mocked(registerImported).mockResolvedValue({ added: 1, skipped: 0 });

    const user = userEvent.setup();
    await upload(user);

    await screen.findByText(/2 件が残りました/);
    await user.type(screen.getByLabelText('ASPの名前'), 'A8.net');
    await user.click(screen.getByLabelText('B社サービス を入れる'));
    await user.click(
      screen.getByRole('button', { name: /選んだ 1 件を下書きとして登録する/ }),
    );

    await waitFor(() => {
      expect(registerImported).toHaveBeenCalledTimes(1);
    });

    const [asp, items] = vi.mocked(registerImported).mock.calls[0] ?? [];

    expect(asp).toBe('A8.net');
    expect(items).toHaveLength(1);
    expect(items?.[0]?.name).toBe('A社サービス');
  });

  /** **すでに在ったものを黙って隠さない** */
  it('飛ばした件数も伝える', async () => {
    vi.mocked(registerImported).mockResolvedValue({ added: 3, skipped: 2 });

    const user = userEvent.setup();
    await upload(user);

    await screen.findByText(/1 件が残りました/);
    await user.type(screen.getByLabelText('ASPの名前'), 'A8.net');
    await user.click(
      screen.getByRole('button', { name: /選んだ 1 件を下書きとして登録する/ }),
    );

    expect(await screen.findByText(/2 件はすでに登録済み/)).toBeVisible();
  });

  it('断られた理由を出す', async () => {
    vi.mocked(registerImported).mockRejectedValue(
      new CatalogApiError(422, '入力を確かめてください'),
    );

    const user = userEvent.setup();
    await upload(user);

    await screen.findByText(/1 件が残りました/);
    await user.type(screen.getByLabelText('ASPの名前'), 'A8.net');
    await user.click(
      screen.getByRole('button', { name: /選んだ 1 件を下書きとして登録する/ }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '入力を確かめてください',
    );
  });
});
