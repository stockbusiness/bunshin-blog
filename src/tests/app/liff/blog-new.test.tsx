import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewBlogPage from '@/app/liff/blogs/new/page';
import {
  BlogApiError,
  createBlog,
  fetchBlogs,
  type BlogListJson,
} from '@/app/liff/_lib/blogs-api';
import {
  fetchPersonas,
  type PersonaJson,
  type PersonaListJson,
} from '@/app/liff/_lib/personas-api';

/**
 * `/liff/blogs/new` ブログの枠をつくる（オンボーディング段5）。
 *
 * **この画面が無いあいだ、段5は誰にも通せなかった。** 段5は
 * `/liff/blogs` を指し、`/liff/blogs` は「オンボーディングから登録して
 * ください」と書いていた。**互いが相手を指していた。**
 *
 * 段5が通らないと段6以降へ一歩も進めない。二度と塞がらないよう見張る。
 */

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/app/liff/_lib/blogs-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/blogs-api')>();

  return { ...actual, fetchBlogs: vi.fn(), createBlog: vi.fn() };
});

vi.mock('@/app/liff/_lib/personas-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/personas-api')>();

  return { ...actual, fetchPersonas: vi.fn() };
});

function persona(overrides: Partial<PersonaJson> = {}): PersonaJson {
  return {
    id: 'persona-1',
    name: 'モッティ',
    personaType: 'SELF',
    identity: {
      name: 'モッティ',
      firstPerson: '私',
      background: '会社勤めをしながら副業でブログを書いている',
      tone: {
        style: 'です・ます調',
        emojiLevel: 'low',
        lineBreak: 'short',
        politeness: '丁寧だが堅すぎない',
      },
      values: { priorities: ['自分で試す'], avoid: ['不安をあおる'] },
      ngExpressions: ['絶対に稼げる'],
    },
    expertise: {
      fields: ['副業', 'アフィリエイト'],
      sources: ['自分で使った記録'],
      evaluationCriteria: ['自分で試したか'],
    },
    audience: {
      ageRange: '30代〜40代',
      situation: '会社勤めをしながら副収入を作りたい',
      knowledgeLevel: 'beginner',
      problems: ['何から始めればいいか分からない'],
      searchIntents: ['副業 初心者'],
    },
    business: {
      revenuePolicy: '自分で使ったものだけ紹介する',
      monthlyGoalYen: 30000,
      kpis: ['成果件数'],
      exitCriteria: '3か月成果0件でやめる',
    },
    status: 'ACTIVE',
    ...overrides,
  };
}

function personaList(personas: PersonaJson[]): PersonaListJson {
  return {
    personas,
    limits: {
      max: 3,
      active: personas.length,
      allowedNow: 1,
      joinedDays: 1,
      nextUnlockInDays: 29,
    },
  };
}

function blogList(overrides: Partial<BlogListJson> = {}): BlogListJson {
  return {
    blogs: [],
    slots: { limit: 3, available: [1, 2, 3], remaining: 3 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchPersonas).mockResolvedValue(personaList([persona()]));
  vi.mocked(fetchBlogs).mockResolvedValue(blogList());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('つくれる', () => {
  it('分身が1体なら選んだ状態で始まる', async () => {
    render(<NewBlogPage />);

    const select = await screen.findByLabelText('書く分身');

    expect(select).toHaveValue('persona-1');
  });

  /** **同じことを二度書かせない。** 読者像は分身が既に持っている */
  it('読者は分身の読者像から下書きが入る', async () => {
    render(<NewBlogPage />);

    const reader = await screen.findByLabelText('誰に向けて書くか');

    expect(reader).toHaveValue(
      '30代〜40代。会社勤めをしながら副収入を作りたい',
    );
  });

  it('名前を入れて送ると、できた設定画面へ進む', async () => {
    vi.mocked(createBlog).mockResolvedValue({
      blog: { id: 'blog-9' } as never,
    });

    const user = userEvent.setup();
    render(<NewBlogPage />);

    await user.type(await screen.findByLabelText('ブログの名前'), '副業メモ');
    await user.click(screen.getByRole('button', { name: 'つくる' }));

    await waitFor(() => {
      expect(createBlog).toHaveBeenCalledWith({
        personaId: 'persona-1',
        name: '副業メモ',
        slug: 'blog-1',
        targetReader: '30代〜40代。会社勤めをしながら副収入を作りたい',
      });
    });

    expect(push).toHaveBeenCalledWith('/liff/blogs/blog-9/settings');
  });

  it('名前が空のあいだは送れない', async () => {
    render(<NewBlogPage />);

    expect(
      await screen.findByRole('button', { name: 'つくる' }),
    ).toBeDisabled();
  });

  it('保存に失敗すると理由を出す', async () => {
    vi.mocked(createBlog).mockRejectedValue(
      new BlogApiError(422, 'ブログの内容を確認してください'),
    );

    const user = userEvent.setup();
    render(<NewBlogPage />);

    await user.type(await screen.findByLabelText('ブログの名前'), '副業メモ');
    await user.click(screen.getByRole('button', { name: 'つくる' }));

    expect(
      await screen.findByText('ブログの内容を確認してください'),
    ).toBeVisible();
  });
});

/**
 * **「作れません」で終わらせない。** どちらも詰まりだが、
 * 次にすることが違う。
 */
describe('作れないときは、次にすることを書く', () => {
  /** `DRAFT` の分身はサーバーが弾く。選ばせてから断らない */
  it('使い始めた分身が無いなら、分身の一覧へ案内する', async () => {
    vi.mocked(fetchPersonas).mockResolvedValue(
      personaList([persona({ status: 'DRAFT' })]),
    );

    render(<NewBlogPage />);

    expect(
      await screen.findByRole('link', { name: '分身の一覧へ' }),
    ).toHaveAttribute('href', '/liff/personas');
    expect(
      screen.queryByRole('button', { name: 'つくる' }),
    ).not.toBeInTheDocument();
  });

  it('枠が空いていないなら、増やせないと書く', async () => {
    vi.mocked(fetchBlogs).mockResolvedValue(
      blogList({ slots: { limit: 3, available: [], remaining: 0 } }),
    );

    render(<NewBlogPage />);

    expect(await screen.findByText(/枠が空いていません/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'つくる' }),
    ).not.toBeInTheDocument();
  });
});
