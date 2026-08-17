import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnershipPanel } from '@/app/liff/blogs/[blogId]/offers/_components/partnership-panel';
import {
  updateOfferPartnership,
  type OfferJson,
  type PartnershipStatus,
} from '@/app/liff/_lib/offers-api';

/**
 * 提携の状態（Q-060、構想書13章）の描画。
 *
 * 確かめるのは3点。
 *
 * 1. **記事にならないことを先に言う**（言わないと「登録したのに来ない」になる）
 * 2. **打つのはリンクだけ。** 状態は選ばせない
 * 3. **断られたことは本人にしか分からない**ので、そこだけ聞く
 */

vi.mock('@/app/liff/_lib/offers-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/offers-api')>();

  return { ...actual, updateOfferPartnership: vi.fn() };
});

const update = vi.mocked(updateOfferPartnership);

function offer(partnershipStatus: PartnershipStatus): OfferJson {
  return {
    id: 'offer-1',
    blogId: 'blog-1',
    name: '格安SIM A',
    aspName: 'テストASP',
    advertiserName: null,
    landingPageUrl: 'https://lp.example.com/a',
    affiliateUrl: partnershipStatus === 'APPROVED' ? 'https://asp/1' : null,
    partnershipStatus,
    rewardYen: 1_480,
    conversionType: 'FREE_SIGNUP',
    facts: {},
    userExperience: 'USED',
    userRating: null,
    denyConditions: [],
    status: 'ACTIVE',
    linkBrokenAt: null,
  };
}

function renderPanel(status: PartnershipStatus, onChanged = vi.fn()) {
  render(
    <PartnershipPanel
      blogId="blog-1"
      offer={offer(status)}
      onChanged={onChanged}
    />,
  );

  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ offer: offer('APPROVED') });
});

/** **提携できていれば、ここですることは無い** */
describe('提携できているとき', () => {
  it('入力欄を出さない', () => {
    renderPanel('APPROVED');

    expect(screen.getByText('提携できています')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('提携がまだのとき', () => {
  /** **黙って候補から外さない。** 「登録したのに記事が来ない」になる */
  it('記事にならないと伝える', () => {
    renderPanel('APPLIED');

    expect(screen.getByText(/この案件の記事はつくられません/)).toBeVisible();
  });

  it('状態をそのまま出す', () => {
    renderPanel('APPLIED');

    expect(screen.getByText('申請して、返事を待っています')).toBeVisible();
  });

  /** **打つのはリンクだけ。** 状態は選ばせない（Q-058） */
  it('リンクを入れると提携済みとして送る', async () => {
    const user = userEvent.setup();
    const onChanged = renderPanel('APPLIED');

    await user.type(
      screen.getByLabelText('格安SIM Aのアフィリエイトリンク'),
      'https://asp.example.com/click?a=1',
    );
    await user.click(screen.getByRole('button', { name: 'リンクを入れる' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });

    expect(update.mock.calls[0]?.[2]).toEqual({
      affiliateUrl: 'https://asp.example.com/click?a=1',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('リンクが空なら送れない', () => {
    renderPanel('APPLIED');

    expect(
      screen.getByRole('button', { name: 'リンクを入れる' }),
    ).toBeDisabled();
  });

  /** **申請したことは本人にしか分からない**（我々のシステムの外で起きる） */
  it('未申請なら「申請しました」を出す', () => {
    renderPanel('NOT_APPLIED');

    expect(
      screen.getByRole('button', { name: 'ASPに申請しました' }),
    ).toBeVisible();
  });

  it('申請中には「申請しました」を出さない', () => {
    renderPanel('APPLIED');

    expect(
      screen.queryByRole('button', { name: 'ASPに申請しました' }),
    ).toBeNull();
  });

  /**
   * **断られたことは本人にしか分からない。**
   * リンクが来ないだけでは「待っている」と区別できない。
   */
  it('断られたと記録できる', async () => {
    const user = userEvent.setup();
    renderPanel('APPLIED');

    await user.click(
      screen.getByRole('button', { name: '提携を断られました' }),
    );

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('blog-1', 'offer-1', {
        partnershipStatus: 'REJECTED',
      });
    });
  });
});

describe('断られたあと', () => {
  /** **もう一度申請できる。** 断られたら終わりにしない */
  it('もう一度申請したと記録できる', async () => {
    const user = userEvent.setup();
    renderPanel('REJECTED');

    await user.click(
      screen.getByRole('button', { name: 'もう一度申請しました' }),
    );

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('blog-1', 'offer-1', {
        partnershipStatus: 'APPLIED',
      });
    });
  });

  /** **断られた案件にリンクは出ない**（発行できないため） */
  it('リンクの入力欄を出さない', () => {
    renderPanel('REJECTED');

    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('うまくいかないとき', () => {
  it('断られた理由をそのまま出す', async () => {
    update.mockRejectedValue(new Error('こわれた'));

    const user = userEvent.setup();
    renderPanel('APPLIED');

    await user.click(
      screen.getByRole('button', { name: '提携を断られました' }),
    );

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});
