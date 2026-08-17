import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultCsvImport } from '@/app/liff/results/_components/result-csv-import';
import {
  previewResultCsv,
  registerResultCsv,
  type ResultCsvPreviewJson,
  type ResultCsvSummaryJson,
} from '@/app/liff/_lib/results-api';

/**
 * 成果CSVの取り込み（Q-059・Q-058）の描画。
 *
 * 確かめるのは4点。
 *
 * 1. **数字を打たせない。** CSVを選ぶだけ
 * 2. **書き込む前に必ず見せる**（最終GO）
 * 3. **割り当てが残っていたら記録させない**（取りこぼしが0件として残る）
 * 4. **記録のときに列の対応づけを送り返す**（AIを呼び直させない）
 */

vi.mock('@/app/liff/_lib/results-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/results-api')>();

  return {
    ...actual,
    previewResultCsv: vi.fn(),
    registerResultCsv: vi.fn(),
  };
});

const preview = vi.mocked(previewResultCsv);
const register = vi.mocked(registerResultCsv);

function summary(
  overrides: Partial<ResultCsvSummaryJson> = {},
): ResultCsvSummaryJson {
  return {
    blogs: [
      {
        blogId: 'blog-1',
        blogName: '節約ブログ',
        weeks: [{ weekStart: '2026-08-17', conversions: 2, revenueYen: 2_960 }],
        conversions: 2,
        revenueYen: 2_960,
      },
    ],
    unassigned: [],
    weekStarts: ['2026-08-17'],
    rejectedRows: 0,
    unreadable: [],
    totalRows: 2,
    ...overrides,
  };
}

function previewOf(
  overrides: Partial<ResultCsvSummaryJson> = {},
): ResultCsvPreviewJson {
  return {
    headers: ['発生日', '案件名', '報酬額', '状態'],
    mapping: { occurredOn: 0, offerName: 1, rewardYen: 2, status: 3 },
    summary: summary(overrides),
  };
}

async function upload(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.upload(
    screen.getByLabelText('成果レポートのCSV'),
    new File(['発生日,案件名\n2026-08-17,格安SIM A\n'], 'results.csv', {
      type: 'text/csv',
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(previewOf());
  register.mockResolvedValue({ savedWeeks: 1, blogs: [] });
});

describe('CSVを選ぶ', () => {
  /** **書き込む前に必ず見せる。** 90日の一次データを見ないまま上書きしない */
  it('まとめた内容が出る', async () => {
    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);

    expect(await screen.findByText('節約ブログ')).toBeVisible();
    expect(screen.getByText(/成果 2 件・2,960 円/)).toBeVisible();
    expect(register).not.toHaveBeenCalled();
  });

  /** **黙って落とさない** */
  it('数えなかった行を出す', async () => {
    preview.mockResolvedValue(
      previewOf({
        rejectedRows: 3,
        unreadable: [{ rowNumber: 9, problem: '成果が発生した日が空です' }],
      }),
    );

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);

    expect(await screen.findByText(/否認・キャンセルの 3 行/)).toBeVisible();
    expect(screen.getByText(/日付を読めなかった 1 行/)).toBeVisible();
  });

  it('読めなければ理由を出す', async () => {
    preview.mockRejectedValue(new Error('こわれた'));

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});

/**
 * **推測で埋めない。** ASPのアカウントには実験の外のサイトの成果も入りうる。
 */
describe('どのブログか決まっていないとき', () => {
  const UNASSIGNED = {
    unassigned: [
      {
        key: 'しらないあんけん',
        offerName: '知らない案件',
        rows: 1,
        revenueYen: 1_480,
      },
    ],
  };

  /** **取りこぼしが「0件」として残るので、記録させない** */
  it('記録できない', async () => {
    preview.mockResolvedValue(previewOf(UNASSIGNED));

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);

    expect(
      await screen.findByRole('button', { name: 'この内容で記録する' }),
    ).toBeDisabled();
  });

  it('「数えない」も選べる', async () => {
    preview.mockResolvedValue(previewOf(UNASSIGNED));

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);

    expect(
      await screen.findByRole('option', {
        name: 'この実験のブログではない（数えない）',
      }),
    ).toBeInTheDocument();
  });

  /** **選び直したら、その場でまとめ直して見せる**（AIは呼び直さない） */
  it('選ぶとまとめ直す', async () => {
    preview.mockResolvedValueOnce(previewOf(UNASSIGNED));

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);
    await user.selectOptions(await screen.findByRole('combobox'), 'blog-1');

    await waitFor(() => {
      expect(preview).toHaveBeenCalledTimes(2);
    });

    expect(preview.mock.calls[1]?.[0]).toMatchObject({
      mapping: { occurredOn: 0 },
      assignments: { しらないあんけん: 'blog-1' },
    });
  });
});

describe('記録する', () => {
  it('見た内容をそのまま送る', async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={onSaved} />);

    await upload(user);
    await user.click(
      await screen.findByRole('button', { name: 'この内容で記録する' }),
    );

    await waitFor(() => {
      expect(register).toHaveBeenCalledTimes(1);
    });

    // **列の対応づけを送り返す。** 送らないと書き込みの直前にAIが動き、
    // 見た表と違うものが保存されうる
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      mapping: { occurredOn: 0, offerName: 1 },
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('記録できたと伝える', async () => {
    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);
    await user.click(
      await screen.findByRole('button', { name: 'この内容で記録する' }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 週ぶんを記録しました',
    );
  });

  it('断られた理由をそのまま出す', async () => {
    register.mockRejectedValue(new Error('こわれた'));

    const user = userEvent.setup();
    render(<ResultCsvImport onSaved={vi.fn()} />);

    await upload(user);
    await user.click(
      await screen.findByRole('button', { name: 'この内容で記録する' }),
    );

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});
