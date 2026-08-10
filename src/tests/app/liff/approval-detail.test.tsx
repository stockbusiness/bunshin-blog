import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDetail } from '@/app/liff/approvals/_components/approval-detail';
import {
  ApprovalApiError,
  approveApproval,
  fetchApprovalDetail,
  markApprovalViewed,
  requestRevision,
  skipApproval,
  type ApprovalDetailJson,
} from '@/app/liff/_lib/approvals-api';

/**
 * 承認詳細（TASKS F-5、SPEC 6.1）の描画。
 *
 * 完了条件は「**未確認事実とリスク警告が表示される**」。
 *
 * あわせて確かめるのは、**記事本文がこのページのDOMに入らない**こと。
 * 本文はAIが書いた HTML で、E-13 の検査は表現を見るものであり
 * スクリプトを落とすものではない。
 */

vi.mock('@/app/liff/_lib/approvals-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/approvals-api')>();

  return {
    ...actual,
    fetchApprovalDetail: vi.fn(),
    markApprovalViewed: vi.fn(),
    approveApproval: vi.fn(),
    skipApproval: vi.fn(),
    requestRevision: vi.fn(),
  };
});

function detail(
  overrides: Partial<ApprovalDetailJson> = {},
): ApprovalDetailJson {
  return {
    approval: {
      id: 'approval-1',
      blogId: 'blog-1',
      blogName: '節約ブログ',
      status: 'VIEWED',
      proposalType: 'NEW_ARTICLE',
      proposalReason: '集客記事です。読者を収益記事へ誘導します。',
    },
    article: {
      versionNo: 1,
      title: '格安SIMの選び方',
      excerpt: '要約',
      answerCapsule: '結論をここに書きます',
      bodyHtml: '<p>本文です</p>',
      faq: [{ question: '料金は？', answer: '月額500円です' }],
      factCheckStatus: 'PASSED',
      unverifiedClaims: [],
      riskFlags: [],
    },
    generation: {
      modelProvider: 'anthropic',
      modelName: 'claude-test',
      promptVersion: 'v1',
      inputTokens: 100,
      outputTokens: 200,
      estimatedCostUsd: '0.001200',
      createdAt: '2026-08-10T00:00:00.000Z',
    },
    offer: null,
    banners: [],
    ...overrides,
  };
}

const mocked = vi.mocked(fetchApprovalDetail);
const viewed = vi.mocked(markApprovalViewed);
const approve = vi.mocked(approveApproval);
const skip = vi.mocked(skipApproval);
const revision = vi.mocked(requestRevision);

function renderPage() {
  return render(<ApprovalDetail approvalId="approval-1" />);
}

beforeEach(() => {
  mocked.mockReset();
  viewed.mockReset();
  viewed.mockResolvedValue({ status: 'VIEWED' });
  approve.mockReset();
  approve.mockResolvedValue({ status: 'APPROVED' });
  skip.mockReset();
  skip.mockResolvedValue({ status: 'SKIPPED' });
  revision.mockReset();
  revision.mockResolvedValue({ status: 'REVISION_REQUESTED' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('未確認事実とリスク警告（完了条件）', () => {
  it('未確認の事実を出す', async () => {
    mocked.mockResolvedValue(
      detail({
        article: {
          ...detail().article,
          unverifiedClaims: [
            {
              text: '初期費用は3,000円です',
              type: 'PRICE',
              excerpt: '3,000円',
              reason: 'NOT_IN_FACTS',
            },
          ],
        },
      }),
    );

    renderPage();

    expect(
      await screen.findByText('初期費用は3,000円です'),
    ).toBeInTheDocument();
    expect(screen.getByText(/PRICE/)).toBeInTheDocument();
  });

  it('リスク警告を出す', async () => {
    mocked.mockResolvedValue(
      detail({
        article: {
          ...detail().article,
          riskFlags: [
            {
              code: 'ASSERTIVE_CLAIM',
              severity: 'warning',
              message: '効果を断定する表現が含まれています',
              excerpt: '…間違いなくおすすめです…',
            },
          ],
        },
      }),
    );

    renderPage();

    expect(
      await screen.findByText('効果を断定する表現が含まれています'),
    ).toBeInTheDocument();
    expect(screen.getByText(/間違いなくおすすめです/)).toBeInTheDocument();
  });

  it('どちらも無ければ無いと伝える', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await screen.findByText('格安SIMの選び方');

    expect(screen.getAllByText('ありません。')).toHaveLength(2);
  });
});

describe('記事本文をこのページのDOMへ入れない', () => {
  /**
   * **`<img onerror=...>` ひとつでセッションを触られる。**
   * 本文はAIが書いた HTML で、E-13 は表現しか見ていない
   */
  it('本文は sandbox 付きの iframe に入る', async () => {
    mocked.mockResolvedValue(
      detail({
        article: {
          ...detail().article,
          bodyHtml: '<p>本文</p><img src="x" onerror="alert(1)">',
        },
      }),
    );

    const { container } = renderPage();

    await screen.findByText('格安SIMの選び方');

    const frame = container.querySelector('iframe');

    expect(frame).not.toBeNull();
    // 空の `sandbox` はスクリプト・遷移・同一オリジンをすべて止める
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toContain('onerror');
  });

  it('本文の要素がページ側に現れない', async () => {
    mocked.mockResolvedValue(
      detail({
        article: { ...detail().article, bodyHtml: '<script>alert(1)</script>' },
      }),
    );

    const { container } = renderPage();

    await screen.findByText('格安SIMの選び方');

    expect(container.querySelector('script')).toBeNull();
  });
});

describe('SPEC 6.1 の表示項目', () => {
  it('ブログ名・提案理由・結論が出る', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    expect(await screen.findByText('節約ブログ')).toBeInTheDocument();
    expect(screen.getByText(/読者を収益記事へ誘導します/)).toBeInTheDocument();
    expect(screen.getByText('結論をここに書きます')).toBeInTheDocument();
  });

  it('AI生成情報を出す', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    expect(await screen.findByText(/claude-test/)).toBeInTheDocument();
    expect(screen.getByText(/0.001200 USD/)).toBeInTheDocument();
  });

  /** **URLは文字として見せる。** 承認の場で踏ませない */
  it('案件とアフィリエイトURLを文字で出す', async () => {
    mocked.mockResolvedValue(
      detail({
        offer: { name: '格安SIM案件', affiliateUrl: 'https://asp.example/x' },
      }),
    );

    const { container } = renderPage();

    expect(await screen.findByText('格安SIM案件')).toBeInTheDocument();
    expect(screen.getByText('https://asp.example/x')).toBeInTheDocument();
    expect(
      container.querySelector('a[href="https://asp.example/x"]'),
    ).toBeNull();
  });

  it('案件が無ければ無いと伝える', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    expect(await screen.findByText('案件は使いません。')).toBeInTheDocument();
  });

  it('新規記事なら変更点は無いと伝える', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    expect(
      await screen.findByText('新しい記事のため、変更点はありません。'),
    ).toBeInTheDocument();
  });

  it('バナーを出す', async () => {
    mocked.mockResolvedValue(
      detail({
        banners: [
          { id: 'b1', name: '春のキャンペーン', imageUrl: 'x', slot: 'HEADER' },
        ],
      }),
    );

    renderPage();

    expect(await screen.findByText(/春のキャンペーン/)).toBeInTheDocument();
  });
});

describe('他人の承認は開けない', () => {
  /** サーバーが404を返す。画面は文言をそのまま出す */
  it('404 の文言を出す', async () => {
    mocked.mockRejectedValue(new ApprovalApiError(404, '提案が見つかりません'));

    renderPage();

    expect(await screen.findByText('提案が見つかりません')).toBeInTheDocument();
  });
});

describe('操作（F-6、SPEC 6.1）', () => {
  it('開くと view を送る', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await screen.findByText('格安SIMの選び方');

    expect(viewed).toHaveBeenCalledWith('approval-1');
  });

  it('承認できる', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: '承認する' }),
    );

    expect(approve).toHaveBeenCalledWith('approval-1');
    expect(await screen.findByText(/回答済みです/)).toBeInTheDocument();
  });

  it('見送れる', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: '今回は見送る' }),
    );

    expect(skip).toHaveBeenCalledWith('approval-1');
  });

  it('修正を依頼できる', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await userEvent.click(
      await screen.findByRole('radio', { name: '短くしてほしい' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: '修正を依頼する' }),
    );

    expect(revision).toHaveBeenCalledWith('approval-1', {
      requestType: 'SHORTER',
    });
  });

  /** **何を直すか分からない依頼を残さない** */
  it('その他を選んで本文が無ければ押せない', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await userEvent.click(
      await screen.findByRole('radio', { name: 'その他（自由記述）' }),
    );

    expect(
      screen.getByRole('button', { name: '修正を依頼する' }),
    ).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox'), '料金が違います');

    expect(
      screen.getByRole('button', { name: '修正を依頼する' }),
    ).toBeEnabled();
  });

  it('種類を選ぶまで依頼できない', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    expect(
      await screen.findByRole('button', { name: '修正を依頼する' }),
    ).toBeDisabled();
  });

  /** **答えたあとはボタンを消す。** 押せるままだと 409 を見ることになる */
  it('回答済みならボタンを出さない', async () => {
    mocked.mockResolvedValue(
      detail({ approval: { ...detail().approval, status: 'APPROVED' } }),
    );
    viewed.mockResolvedValue({ status: 'APPROVED' });

    renderPage();

    expect(await screen.findByText(/回答済みです/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '承認する' })).toBeNull();
  });

  /** **「後で確認」は何もせず閉じること。** ボタンを置かない */
  it('「後で確認」のボタンは置かない', async () => {
    mocked.mockResolvedValue(detail());

    renderPage();

    await screen.findByText('格安SIMの選び方');

    expect(screen.queryByRole('button', { name: /後で/ })).toBeNull();
  });

  it('送信に失敗したらサーバーの文言を出す', async () => {
    mocked.mockResolvedValue(detail());
    approve.mockRejectedValue(
      new ApprovalApiError(409, 'この提案には既に回答済みです'),
    );

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: '承認する' }),
    );

    expect(
      await screen.findByText('この提案には既に回答済みです'),
    ).toBeInTheDocument();
  });
});
