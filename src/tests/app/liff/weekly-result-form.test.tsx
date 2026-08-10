import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyResultForm } from '@/app/liff/results/_components/weekly-result-form';
import {
  fetchWeeklyResults,
  saveWeeklyResult,
  type WeeklyResultJson,
} from '@/app/liff/_lib/results-api';

/**
 * 週次の成果入力（TASKS G-5）の描画。
 *
 * 完了条件は「成果件数と報酬額のみ入力。**0件を1操作で記録できる**」。
 */

vi.mock('@/app/liff/_lib/results-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/results-api')>();

  return {
    ...actual,
    fetchWeeklyResults: vi.fn(),
    saveWeeklyResult: vi.fn(),
  };
});

function week(overrides: Partial<WeeklyResultJson> = {}): WeeklyResultJson {
  return {
    weekStart: '2026-08-10',
    conversions: 0,
    revenueYen: 0,
    reported: false,
    ...overrides,
  };
}

const list = vi.mocked(fetchWeeklyResults);
const save = vi.mocked(saveWeeklyResult);

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ results: [week()] });
  save.mockReset();
  save.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('0件を1操作で記録できる（完了条件）', () => {
  /** **0件の週に数字を2つ入れるのは面倒で、放っておかれる** */
  it('ボタン1つで0件を送る', async () => {
    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    await userEvent.click(
      await screen.findByRole('button', { name: '今週は成果0件' }),
    );

    expect(save).toHaveBeenCalledWith('blog-1', {
      conversions: 0,
      revenueYen: 0,
    });
  });

  it('入力欄を埋めなくても押せる', async () => {
    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    expect(
      await screen.findByRole('button', { name: '今週は成果0件' }),
    ).toBeEnabled();
  });
});

describe('数値の入力', () => {
  it('件数と金額を送る', async () => {
    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    await userEvent.type(await screen.findByLabelText('成果件数'), '3');
    await userEvent.type(screen.getByLabelText('報酬額（円）'), '4500');
    await userEvent.click(
      screen.getByRole('button', { name: 'この内容で記録する' }),
    );

    expect(save).toHaveBeenCalledWith('blog-1', {
      conversions: 3,
      revenueYen: 4500,
    });
  });

  it('どちらか空なら押せない', async () => {
    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    await userEvent.type(await screen.findByLabelText('成果件数'), '3');

    expect(
      screen.getByRole('button', { name: 'この内容で記録する' }),
    ).toBeDisabled();
  });
});

describe('未入力と0件を区別して見せる（完了条件の意図）', () => {
  it('未入力ならそう出す', async () => {
    list.mockResolvedValue({ results: [week({ reported: false })] });

    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    // 今週の要約と履歴の両方に出る
    expect((await screen.findAllByText(/未入力/)).length).toBeGreaterThan(0);
  });

  it('0件の報告は件数として出す', async () => {
    list.mockResolvedValue({
      results: [week({ reported: true, conversions: 0, revenueYen: 0 })],
    });

    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    expect((await screen.findAllByText(/成果 0件/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/未入力/)).toHaveLength(0);
  });

  it('金額を桁区切りで出す', async () => {
    list.mockResolvedValue({
      results: [week({ reported: true, conversions: 3, revenueYen: 45000 })],
    });

    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    expect((await screen.findAllByText(/45,000円/)).length).toBeGreaterThan(0);
  });
});

describe('失敗の扱い', () => {
  it('保存に失敗したらサーバーの文言を出す', async () => {
    const { ResultApiError } = await import('@/app/liff/_lib/results-api');
    save.mockRejectedValue(
      new ResultApiError(422, '成果が0件なのに報酬額が入っています'),
    );

    render(<WeeklyResultForm blogId="blog-1" blogName="節約ブログ" />);

    await userEvent.click(
      await screen.findByRole('button', { name: '今週は成果0件' }),
    );

    expect(
      await screen.findByText('成果が0件なのに報酬額が入っています'),
    ).toBeInTheDocument();
  });
});
