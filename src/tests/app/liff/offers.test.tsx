import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OffersPage from '@/app/liff/blogs/[blogId]/offers/page';
import {
  OfferApiError,
  createOffer,
  draftOffer,
  fetchOffers,
  type OfferJson,
} from '@/app/liff/_lib/offers-api';

/**
 * `/liff/blogs/[blogId]/offers` 案件を登録する（段8）。
 *
 * **I-3 の完了条件は「オンボーディング STEP 8（案件登録）が画面から
 * 完了できる」だった。** 入口は作られたが、**呼ぶ画面が無いまま完了と
 * されていた**（Q-048）。
 *
 * ここで見張るのは2つ。
 * - **モニターが決めない項目を送らない**（Q-001・Q-014・Q-019）
 * - **「使ったことがあるか」を既定で流さない**（SPEC 9.6）
 */

vi.mock('@/app/liff/_lib/offers-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/offers-api')>();

  return {
    ...actual,
    fetchOffers: vi.fn(),
    createOffer: vi.fn(),
    draftOffer: vi.fn(),
  };
});

function offer(overrides: Partial<OfferJson> = {}): OfferJson {
  return {
    id: 'offer-1',
    blogId: 'blog-1',
    name: '格安SIM案件',
    aspName: 'サンプルASP',
    advertiserName: null,
    landingPageUrl: 'https://lp.example.com/offer',
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    rewardYen: 3000,
    conversionType: 'FREE_SIGNUP',
    facts: {},
    userExperience: 'USED',
    userRating: null,
    denyConditions: [],
    status: 'ACTIVE',
    linkBrokenAt: null,
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <OffersPage params={Promise.resolve({ blogId: 'blog-1' })} />
      </Suspense>,
    );
  });
}

/** 必須の5項目を埋める */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('案件の名前'), '格安SIM案件');
  await user.type(screen.getByLabelText('ASP の名前'), 'サンプルASP');
  await user.type(
    screen.getByLabelText('紹介先のページ'),
    'https://lp.example.com/offer',
  );
  await user.type(
    screen.getByLabelText('アフィリエイトリンク'),
    'https://asp.example/click?a=xxxx',
  );
  await user.selectOptions(
    screen.getByLabelText('自分で使ったことがあるか'),
    'USED',
  );
}

beforeEach(() => {
  vi.mocked(fetchOffers).mockResolvedValue({ offers: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('登録できる', () => {
  it('必須を埋めると送れる', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalledWith('blog-1', {
        name: '格安SIM案件',
        aspName: 'サンプルASP',
        landingPageUrl: 'https://lp.example.com/offer',
        affiliateUrl: 'https://asp.example/click?a=xxxx',
        conversionType: 'FREE_SIGNUP',
        userExperience: 'USED',
      });
    });
  });

  /**
   * **モニターが決めない項目を送らない**（Q-001・Q-014・Q-019）。
   * ASPの規約に関わる判断で、誤ると成果が無効になる
   */
  it('リンク方式・サブID・掲載可否を送らない', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalled();
    });

    const sent = vi.mocked(createOffer).mock.calls[0]?.[1] ?? {};

    expect(sent).not.toHaveProperty('linkMode');
    expect(sent).not.toHaveProperty('subIdParam');
    expect(sent).not.toHaveProperty('blogPostingProhibited');
    expect(sent).not.toHaveProperty('selectionScore');
  });

  /** **報酬額は省ける。** 分からないまま止まらせない */
  it('報酬額が空でも送れる', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalled();
    });

    expect(vi.mocked(createOffer).mock.calls[0]?.[1]).not.toHaveProperty(
      'rewardYen',
    );
  });

  /**
   * **`facts` は記事に書ける数値の出どころ**（SPEC 9.6、Q-050）。
   * ここに無い価格・条件は書かせない。
   */
  it('事実を1行に1つで送る', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.type(
      screen.getByLabelText('事実（1行に1つ）'),
      '月額1,480円{Enter}初期費用なし',
    );
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalledWith(
        'blog-1',
        expect.objectContaining({
          facts: { items: ['月額1,480円', '初期費用なし'] },
        }),
      );
    });
  });

  /**
   * **空なら送らない。** 送ると `facts_updated_at` が入り、
   * 「確かめた」ことになってしまう（D-13・Q-022）
   */
  it('事実が空なら送らない', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalled();
    });

    expect(vi.mocked(createOffer).mock.calls[0]?.[1]).not.toHaveProperty(
      'facts',
    );
  });

  it('報酬額を入れれば数値で送る', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.type(screen.getByLabelText('報酬額（円）'), '3000');
    await user.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() => {
      expect(createOffer).toHaveBeenCalledWith(
        'blog-1',
        expect.objectContaining({ rewardYen: 3000 }),
      );
    });
  });

  /** **続けて登録できる。** 1件ごとに画面を開き直させない */
  it('登録すると一覧に増え、入力欄が空に戻る', async () => {
    vi.mocked(createOffer).mockResolvedValue({ offer: offer() });

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    expect(await screen.findByText('登録済み（1 件）')).toBeVisible();
    expect(screen.getByLabelText('案件の名前')).toHaveValue('');
  });

  it('保存に失敗すると理由を出す', async () => {
    vi.mocked(createOffer).mockRejectedValue(
      new OfferApiError(422, '案件の内容を確認してください'),
    );

    const user = userEvent.setup();
    await renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '登録する' }));

    expect(
      await screen.findByText('案件の内容を確認してください'),
    ).toBeVisible();
  });
});

/**
 * **AIは案を出す係**（Q-053）。読み取った値は下書きで、
 * **人が確かめてから登録される。**
 */
describe('ページから読み取る', () => {
  it('読み取ると入力欄が埋まる', async () => {
    vi.mocked(draftOffer).mockResolvedValue({
      draft: {
        name: '格安SIM A',
        conversionType: 'PURCHASE',
        facts: ['月額1,480円', '初期費用なし'],
      },
    });

    const user = userEvent.setup();
    await renderPage();

    await user.type(
      await screen.findByLabelText('紹介先のページ'),
      'https://lp.example.com',
    );
    await user.click(
      screen.getByRole('button', { name: 'このページから読み取る' }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText('案件の名前')).toHaveValue('格安SIM A');
    });

    expect(screen.getByLabelText('事実（1行に1つ）')).toHaveValue(
      '月額1,480円\n初期費用なし',
    );
  });

  /**
   * **下書きのまま通させない**（D-13・Q-022）。登録すると
   * `facts_updated_at` が入り「確かめた」ことになる。
   */
  it('読み取ったら、確かめるよう伝える', async () => {
    vi.mocked(draftOffer).mockResolvedValue({
      draft: { name: 'A', conversionType: 'TRIAL', facts: ['月額1,480円'] },
    });

    const user = userEvent.setup();
    await renderPage();

    await user.type(
      await screen.findByLabelText('紹介先のページ'),
      'https://lp.example.com',
    );
    await user.click(
      screen.getByRole('button', { name: 'このページから読み取る' }),
    );

    expect(await screen.findByText(/必ず確かめてください/)).toBeVisible();
  });

  /** **手で入力する道を塞がない** */
  it('読み取れなくても、入力欄はそのまま使える', async () => {
    vi.mocked(draftOffer).mockRejectedValue(
      new OfferApiError(422, '読み取れませんでした。手で入力してください'),
    );

    const user = userEvent.setup();
    await renderPage();

    await user.type(
      await screen.findByLabelText('紹介先のページ'),
      'https://lp.example.com',
    );
    await user.click(
      screen.getByRole('button', { name: 'このページから読み取る' }),
    );

    expect(
      await screen.findByText('読み取れませんでした。手で入力してください'),
    ).toBeVisible();
    expect(screen.getByLabelText('案件の名前')).toBeEnabled();
  });

  it('URLが空のあいだは読み取れない', async () => {
    await renderPage();

    expect(
      await screen.findByRole('button', { name: 'このページから読み取る' }),
    ).toBeDisabled();
  });
});

describe('送れないとき', () => {
  /**
   * **既定で流さない**（SPEC 9.6）。既定にすると、使っていない案件に
   * 「使ってみました」と書きうる
   */
  it('使ったことがあるかを選ぶまで送れない', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(await screen.findByLabelText('案件の名前'), '案件');
    await user.type(screen.getByLabelText('ASP の名前'), 'ASP');
    await user.type(
      screen.getByLabelText('紹介先のページ'),
      'https://lp.example.com',
    );
    await user.type(
      screen.getByLabelText('アフィリエイトリンク'),
      'https://asp.example/click',
    );

    expect(screen.getByRole('button', { name: '登録する' })).toBeDisabled();

    await user.selectOptions(
      screen.getByLabelText('自分で使ったことがあるか'),
      'NOT_USED',
    );

    expect(screen.getByRole('button', { name: '登録する' })).toBeEnabled();
  });

  it('名前が空のあいだは送れない', async () => {
    await renderPage();

    expect(
      await screen.findByRole('button', { name: '登録する' }),
    ).toBeDisabled();
  });
});

describe('登録済みの案件', () => {
  it('名前とASPと報酬額を出す', async () => {
    vi.mocked(fetchOffers).mockResolvedValue({ offers: [offer()] });

    await renderPage();

    expect(await screen.findByText('格安SIM案件')).toBeVisible();
    expect(screen.getByText(/サンプルASP・使用中・3,000 円/)).toBeVisible();
  });

  /**
   * **空のまま気づかないと、記事に数字を書けないことが後で分かる**
   * （Q-050）。一覧で言う。
   */
  it('事実の件数を出す。空なら未記入と言う', async () => {
    vi.mocked(fetchOffers).mockResolvedValue({
      offers: [
        offer(),
        offer({
          id: 'offer-2',
          name: '光回線案件',
          facts: { items: ['月額'] },
        }),
      ],
    });

    await renderPage();

    expect(await screen.findByText('事実が未記入です')).toBeVisible();
    expect(screen.getByText('事実 1 件')).toBeVisible();
  });

  /** **切れているリンクを黙って置かない**（H-3b） */
  it('リンクが切れていれば知らせる', async () => {
    vi.mocked(fetchOffers).mockResolvedValue({
      offers: [offer({ linkBrokenAt: '2026-08-01T00:00:00.000Z' })],
    });

    await renderPage();

    expect(await screen.findByText('リンクが切れています')).toBeVisible();
  });

  /** **読めなくても登録は続けられる。** 一覧が出ないだけ */
  it('読み込みに失敗しても登録欄は出る', async () => {
    vi.mocked(fetchOffers).mockRejectedValue(
      new OfferApiError(0, '通信に失敗しました'),
    );

    await renderPage();

    expect(await screen.findByText('通信に失敗しました')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '登録する' }),
    ).toBeInTheDocument();
  });
});
