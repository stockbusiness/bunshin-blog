import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalListPage from '@/app/liff/approvals/page';
import {
  ApprovalApiError,
  fetchApprovals,
  type ApprovalJson,
} from '@/app/liff/_lib/approvals-api';

/**
 * 承認一覧（TASKS F-4、SPEC 6.1）の描画。
 *
 * **確認が要るものを開く前に示しているか**を確かめる。
 * 事実チェックの `WARNING` と表現の指摘は、開いてから気づくのでは遅い。
 */

vi.mock('@/app/liff/_lib/approvals-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/approvals-api')>();

  return { ...actual, fetchApprovals: vi.fn() };
});

function approval(overrides: Partial<ApprovalJson> = {}): ApprovalJson {
  return {
    id: 'approval-1',
    blogId: 'blog-1',
    blogName: '節約ブログ',
    articleTitle: '格安SIMの選び方',
    status: 'PENDING',
    proposalType: 'NEW_ARTICLE',
    proposalReason: '集客記事です。読者を収益記事へ誘導します。',
    factCheckStatus: 'PASSED',
    riskFlagCount: 0,
    sentAt: '2026-08-10T00:00:00.000Z',
    respondedAt: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

const mocked = vi.mocked(fetchApprovals);

beforeEach(() => {
  mocked.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('一覧の描画', () => {
  it('承認待ちの提案が出る', async () => {
    mocked.mockResolvedValue({ approvals: [approval()] });

    render(<ApprovalListPage />);

    expect(await screen.findByText('格安SIMの選び方')).toBeInTheDocument();
    expect(screen.getByText('節約ブログ')).toBeInTheDocument();
  });

  it('提案理由を出す', async () => {
    mocked.mockResolvedValue({ approvals: [approval()] });

    render(<ApprovalListPage />);

    expect(
      await screen.findByText(/読者を収益記事へ誘導します/),
    ).toBeInTheDocument();
  });

  it('空なら空と伝える', async () => {
    mocked.mockResolvedValue({ approvals: [] });

    render(<ApprovalListPage />);

    expect(
      await screen.findByText('承認待ちの提案はありません。'),
    ).toBeInTheDocument();
  });

  it('読み込みに失敗したらサーバーの文言を出す', async () => {
    mocked.mockRejectedValue(new ApprovalApiError(403, '同意が必要です'));

    render(<ApprovalListPage />);

    expect(await screen.findByText('同意が必要です')).toBeInTheDocument();
  });
});

describe('確認が要るものを開く前に示す', () => {
  /** **開いてから気づくより早く、どれに時間がかかるか分かる** */
  it('未確認の事実があれば行に出す', async () => {
    mocked.mockResolvedValue({
      approvals: [approval({ factCheckStatus: 'WARNING' })],
    });

    render(<ApprovalListPage />);

    expect(await screen.findByText(/未確認の事実あり/)).toBeInTheDocument();
  });

  it('表現の指摘の件数を出す', async () => {
    mocked.mockResolvedValue({ approvals: [approval({ riskFlagCount: 2 })] });

    render(<ApprovalListPage />);

    expect(await screen.findByText(/表現の指摘 2件/)).toBeInTheDocument();
  });

  it('問題が無ければ何も足さない', async () => {
    mocked.mockResolvedValue({ approvals: [approval()] });

    render(<ApprovalListPage />);

    await screen.findByText('格安SIMの選び方');

    expect(screen.queryByText(/未確認の事実あり/)).not.toBeInTheDocument();
    expect(screen.queryByText(/表現の指摘/)).not.toBeInTheDocument();
  });
});

describe('タブ（SPEC 6.1）', () => {
  it('4つ出る', async () => {
    mocked.mockResolvedValue({ approvals: [] });

    render(<ApprovalListPage />);

    for (const label of ['承認待ち', '承認済み', '修正依頼', '見送り']) {
      expect(
        await screen.findByRole('tab', { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });

  it('件数を出す', async () => {
    mocked.mockResolvedValue({
      approvals: [approval(), approval({ id: 'approval-2' })],
    });

    render(<ApprovalListPage />);

    expect(
      await screen.findByRole('tab', { name: '承認待ち 2' }),
    ).toBeInTheDocument();
  });

  it('切り替えると中身が変わる', async () => {
    mocked.mockResolvedValue({
      approvals: [
        approval(),
        approval({
          id: 'approval-2',
          status: 'SKIPPED',
          articleTitle: '見送った記事',
        }),
      ],
    });

    render(<ApprovalListPage />);

    expect(await screen.findByText('格安SIMの選び方')).toBeInTheDocument();
    expect(screen.queryByText('見送った記事')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '見送り 1' }));

    expect(screen.getByText('見送った記事')).toBeInTheDocument();
    expect(screen.queryByText('格安SIMの選び方')).not.toBeInTheDocument();
  });

  /** **開いただけで一覧から消えない** */
  it('VIEWED は承認待ちに残る', async () => {
    mocked.mockResolvedValue({ approvals: [approval({ status: 'VIEWED' })] });

    render(<ApprovalListPage />);

    expect(await screen.findByText('格安SIMの選び方')).toBeInTheDocument();
    expect(screen.getByText(/確認中/)).toBeInTheDocument();
  });

  /** **期限切れが画面から消えない**（SPEC の4つには無い状態） */
  it('EXPIRED は見送りに出て、行では期限切れと分かる', async () => {
    mocked.mockResolvedValue({ approvals: [approval({ status: 'EXPIRED' })] });

    render(<ApprovalListPage />);

    await userEvent.click(await screen.findByRole('tab', { name: '見送り 1' }));

    expect(screen.getByText(/期限切れ/)).toBeInTheDocument();
  });
});
