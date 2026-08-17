import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewPersonaPage, { readFields } from '@/app/liff/personas/new/page';
import {
  PersonaApiError,
  createPersona,
  draftPersona,
  type PersonaInput,
} from '@/app/liff/_lib/personas-api';

/**
 * 段4「分身をつくる」（Q-058・Q-047）。
 *
 * 確かめるのは4点。
 *
 * 1. **最初に聞くのは3つだけ。** 23項目をいきなり出さない
 * 2. **3つ揃うまで進めない。** 揃わないと30ブログが全部似る
 * 3. **下書きのあと、23項目の画面に「答えたままだ」と出る**
 * 4. **手で全部入れる道を塞がない**
 */

vi.mock('@/app/liff/_lib/personas-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/liff/_lib/personas-api')>();

  return { ...actual, draftPersona: vi.fn(), createPersona: vi.fn() };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const DRAFT: PersonaInput = {
  name: '節約の人',
  personaType: 'SELF',
  identity: {
    name: 'さとし',
    firstPerson: '私',
    background: '一人暮らしで通信費を見直した',
    tone: {
      style: 'やわらかい説明口調',
      emojiLevel: 'low',
      lineBreak: 'normal',
      politeness: 'ですます',
    },
    values: { priorities: ['正確さ'], avoid: ['煽り'] },
    ngExpressions: ['絶対に儲かる'],
  },
  expertise: {
    fields: ['格安SIM'],
    sources: ['総務省の統計'],
    evaluationCriteria: ['月額と初期費用'],
  },
  audience: {
    ageRange: '20〜30代',
    situation: '一人暮らしを始めたばかり',
    knowledgeLevel: 'beginner',
    problems: ['通信費が高い'],
    searchIntents: ['格安SIM 比較'],
  },
  business: {
    revenuePolicy: '無料登録から',
    monthlyGoalYen: 10000,
    kpis: ['クリック数'],
    exitCriteria: '3か月やって月1,000円に届かなければやめる',
  },
};

async function answerAll(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.type(screen.getByLabelText(/何について書きたいですか/), '格安SIM');
  await user.type(screen.getByLabelText(/誰に向けて書きますか/), '一人暮らし');
  await user.type(
    screen.getByLabelText(/どうなったらやめますか/),
    '3か月で見直す',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('1行に1つ読む', () => {
  it('空行を落とす', () => {
    expect(readFields('格安SIM\n\n  通信費  \n')).toEqual([
      '格安SIM',
      '通信費',
    ]);
  });

  it('空なら0件', () => {
    expect(readFields('   \n  ')).toEqual([]);
  });
});

/** **23項目をいきなり出さない**（Q-058） */
describe('最初は3つだけ聞く', () => {
  it('3つの問いだけが出る', () => {
    render(<NewPersonaPage />);

    expect(screen.getByLabelText(/何について書きたいですか/)).toBeVisible();
    expect(screen.getByLabelText(/誰に向けて書きますか/)).toBeVisible();
    expect(screen.getByLabelText(/どうなったらやめますか/)).toBeVisible();

    // 23項目の画面はまだ出さない
    expect(screen.queryByLabelText('一人称')).toBeNull();
    expect(screen.queryByLabelText('文体')).toBeNull();
  });

  /** **揃わないまま進めない。** AIが埋めると30ブログが全部似る */
  it('3つ揃うまで押せない', async () => {
    const user = userEvent.setup();
    render(<NewPersonaPage />);

    const button = screen.getByRole('button', {
      name: '残りを下書きしてもらう',
    });

    expect(button).toBeDisabled();

    await user.type(
      screen.getByLabelText(/何について書きたいですか/),
      '格安SIM',
    );
    expect(button).toBeDisabled();

    await user.type(
      screen.getByLabelText(/誰に向けて書きますか/),
      '一人暮らし',
    );
    expect(button).toBeDisabled();

    await user.type(
      screen.getByLabelText(/どうなったらやめますか/),
      '3か月で見直す',
    );
    expect(button).toBeEnabled();
  });

  /**
   * **やめる条件はAIに決めさせない。** 先に決める理由が
   * 「後から決めるとかけた時間に引きずられるから」なので、
   * その理由を画面にも書く。
   */
  it('やめる条件は自分で決めるものだと伝える', () => {
    render(<NewPersonaPage />);

    expect(
      screen.getByText(/ここだけは、ご自身で決めてください/),
    ).toBeVisible();
  });
});

describe('下書きができたあと', () => {
  it('23項目の画面が埋まって出る', async () => {
    vi.mocked(draftPersona).mockResolvedValue({ draft: DRAFT });

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    expect(await screen.findByLabelText('一人称')).toHaveValue('私');
    expect(screen.getByLabelText('文体')).toHaveValue('やわらかい説明口調');
  });

  /** **どこが自分のものかを出す**（Q-058 の「下書きと既定値を混ぜない」） */
  it('答えた2つは答えのままだと伝える', async () => {
    vi.mocked(draftPersona).mockResolvedValue({ draft: DRAFT });

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    expect(await screen.findByText(/あなたが答えたままです/)).toBeVisible();
  });

  it('答えた3つをそのまま送る', async () => {
    vi.mocked(draftPersona).mockResolvedValue({ draft: DRAFT });

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    await waitFor(() => {
      expect(draftPersona).toHaveBeenCalledTimes(1);
    });

    expect(vi.mocked(draftPersona).mock.calls[0]?.[0]).toEqual({
      fields: ['格安SIM'],
      audience: '一人暮らし',
      exitCriteria: '3か月で見直す',
    });
  });
});

/** **手で全部入れる道を塞がない** */
describe('じぶんで入力する', () => {
  it('押すと23項目の画面になる', async () => {
    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await user.click(
      screen.getByRole('button', { name: '全部じぶんで入力する' }),
    );

    expect(await screen.findByLabelText('一人称')).toBeVisible();
    expect(draftPersona).not.toHaveBeenCalled();
  });
});

describe('うまくいかないとき', () => {
  it('断られた理由をそのまま出す', async () => {
    vi.mocked(draftPersona).mockRejectedValue(
      new PersonaApiError(
        422,
        '下書きを作れませんでした。手で入力してください',
      ),
    );

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '下書きを作れませんでした。手で入力してください',
    );
  });

  /** **失敗しても3つの答えを消さない。** 打ち直させない */
  it('失敗しても答えは残る', async () => {
    vi.mocked(draftPersona).mockRejectedValue(
      new PersonaApiError(500, 'うまくいきませんでした'),
    );

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    await screen.findByRole('alert');

    expect(screen.getByLabelText(/誰に向けて書きますか/)).toHaveValue(
      '一人暮らし',
    );
  });
});

describe('保存する', () => {
  it('下書きから保存できる', async () => {
    vi.mocked(draftPersona).mockResolvedValue({ draft: DRAFT });
    vi.mocked(createPersona).mockResolvedValue({
      persona: { id: 'p1' },
    } as never);

    const user = userEvent.setup();
    render(<NewPersonaPage />);

    await answerAll(user);
    await user.click(
      screen.getByRole('button', { name: '残りを下書きしてもらう' }),
    );

    await user.click(
      await screen.findByRole('button', { name: '下書きとして保存する' }),
    );

    await waitFor(() => {
      expect(createPersona).toHaveBeenCalledTimes(1);
    });

    const sent = vi.mocked(createPersona).mock.calls[0]?.[0];

    expect(sent?.expertise.fields).toEqual(['格安SIM']);
    expect(sent?.business.exitCriteria).toBe(
      '3か月やって月1,000円に届かなければやめる',
    );
  });
});
