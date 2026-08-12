import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PersonaListPage from '@/app/liff/personas/page';
import {
  fetchPersonas,
  type PersonaJson,
  type PersonaLimitsJson,
  type PersonaListJson,
} from '@/app/liff/_lib/personas-api';
import { describePersonaLimits } from '@/app/liff/_lib/persona-labels';

/**
 * 分身の一覧（TASKS D-14）の描画（TASKS B-9）。
 *
 * ここで確かめるのは **「上限です」だけになっていないか**。待てば開くのか、
 * 止めれば開くのかで、モニターが次に取る行動が変わる。
 */

vi.mock('@/app/liff/_lib/personas-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/personas-api')>();

  return { ...actual, fetchPersonas: vi.fn() };
});

function persona(overrides: Partial<PersonaJson> = {}): PersonaJson {
  return {
    id: 'persona-1',
    name: '節約の人',
    personaType: 'SELF',
    identity: {
      name: 'まこと',
      firstPerson: '私',
      background: '30代の会社員',
      tone: {
        style: 'やわらかい',
        emojiLevel: 'low',
        lineBreak: 'normal',
        politeness: 'です・ます',
      },
      values: { priorities: ['正確さ'], avoid: ['煽り'] },
      ngExpressions: [],
    },
    expertise: {
      fields: ['家計管理'],
      sources: [],
      evaluationCriteria: [],
    },
    audience: {
      ageRange: '30代',
      situation: '子育て中',
      knowledgeLevel: 'beginner',
      problems: [],
      searchIntents: [],
    },
    business: {
      revenuePolicy: '使ったものだけ紹介する',
      monthlyGoalYen: 30_000,
      kpis: [],
      exitCriteria: '3か月で伸びなければ畳む',
    },
    status: 'ACTIVE',
    ...overrides,
  };
}

function limits(overrides: Partial<PersonaLimitsJson> = {}): PersonaLimitsJson {
  return {
    max: 3,
    active: 1,
    allowedNow: 1,
    joinedDays: 10,
    nextUnlockInDays: 20,
    ...overrides,
  };
}

function listJson(overrides: Partial<PersonaListJson> = {}): PersonaListJson {
  return { personas: [persona()], limits: limits(), ...overrides };
}

beforeEach(() => {
  vi.mocked(fetchPersonas).mockResolvedValue(listJson());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('分身の一覧', () => {
  it('名前・種類・状態・専門領域を出す', async () => {
    render(<PersonaListPage />);

    expect(await screen.findByText('節約の人')).toBeInTheDocument();
    expect(screen.getByText(/自分そのまま/)).toBeInTheDocument();
    expect(screen.getByText(/使用中/)).toBeInTheDocument();
    expect(screen.getByText('家計管理')).toBeInTheDocument();
  });

  /**
   * **`ARCHIVED` も出す。** 途中でやめた分身があること自体が実験の記録で、
   * 消すと「最初から作らなかった」と区別できない
   */
  it('終了した分身も一覧に出る', async () => {
    vi.mocked(fetchPersonas).mockResolvedValue(
      listJson({
        personas: [
          persona(),
          persona({ id: 'persona-2', name: 'やめた人', status: 'ARCHIVED' }),
        ],
      }),
    );

    render(<PersonaListPage />);

    expect(await screen.findByText('やめた人')).toBeInTheDocument();
    expect(screen.getByText(/終了/)).toBeInTheDocument();
  });

  it('1体もいなければ、まず作るよう促す', async () => {
    vi.mocked(fetchPersonas).mockResolvedValue(
      listJson({ personas: [], limits: limits({ active: 0 }) }),
    );

    render(<PersonaListPage />);

    expect(await screen.findByText(/まだ分身がいません/)).toBeInTheDocument();
  });

  it('読み込みに失敗したらサーバーの文言を出す', async () => {
    vi.mocked(fetchPersonas).mockRejectedValue(new Error('boom'));

    render(<PersonaListPage />);

    expect(await screen.findByText('読み込めませんでした')).toBeInTheDocument();
  });
});

/**
 * **「上限です」だけにしない**（D-14）。
 *
 * | 状況 | 伝えること |
 * |---|---|
 * | 空きがある | あと何体使えるか |
 * | 経過日数で止まっている | **あと何日で開くか** |
 * | もう開かない | 休止すれば入れ替えられること |
 */
describe('上限の説明', () => {
  it('空きがあれば残り数を出す', async () => {
    vi.mocked(fetchPersonas).mockResolvedValue(
      listJson({ limits: limits({ active: 1, allowedNow: 2 }) }),
    );

    render(<PersonaListPage />);

    expect(await screen.findByText(/あと 1 体/)).toBeInTheDocument();
  });

  it('段階解放で止まっているなら、開くまでの日数を出す', async () => {
    render(<PersonaListPage />);

    expect(await screen.findByText(/あと 20 日/)).toBeInTheDocument();
    expect(screen.getByText(/2 体目/)).toBeInTheDocument();
  });

  /** **待っても開かないなら、そう言う。** 日数を出すと嘘になる */
  it('全体の上限に達していれば、休止を促す', async () => {
    vi.mocked(fetchPersonas).mockResolvedValue(
      listJson({
        limits: limits({
          active: 3,
          allowedNow: 3,
          joinedDays: 70,
          nextUnlockInDays: null,
        }),
      }),
    );

    render(<PersonaListPage />);

    expect(await screen.findByText(/休止してください/)).toBeInTheDocument();
  });
});

/** 文面そのものは純粋関数で固める（描画を通さずに全分岐を見る） */
describe('describePersonaLimits', () => {
  it.each([
    {
      name: '空きがある',
      value: limits({ active: 1, allowedNow: 3, nextUnlockInDays: null }),
      expected: 'あと 2 体',
    },
    {
      name: '段階解放で止まっている',
      value: limits({ active: 1, allowedNow: 1, nextUnlockInDays: 20 }),
      expected: 'あと 20 日',
    },
    {
      name: '全体の上限',
      value: limits({
        active: 3,
        allowedNow: 3,
        joinedDays: 70,
        nextUnlockInDays: null,
      }),
      expected: '休止してください',
    },
    {
      name: '参加前（段階解放は効かない）',
      value: limits({
        active: 3,
        allowedNow: 3,
        joinedDays: null,
        nextUnlockInDays: null,
      }),
      expected: '休止してください',
    },
  ])('$name', ({ value, expected }) => {
    expect(describePersonaLimits(value)).toContain(expected);
  });
});
