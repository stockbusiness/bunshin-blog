import { describe, expect, it, vi } from 'vitest';
import { draftPersonaFromAnswers } from '@/modules/personas';
import type { AiProvider } from '@/lib/ai';

/**
 * 3つの答えから分身を下書きする（Q-058、Q-047、段4）。
 *
 * 守りたいのは2つ。
 *
 * 1. **本人が答えた3つをAIに書き換えさせない。** とくに
 *    **やめる条件**——AIが書いた条件では、「先に決める」という
 *    仕掛けそのものが無意味になる
 * 2. **読めない下書きを通さない。** 通すと、23項目のうち
 *    どこかが壊れた分身がそのまま記事を書く
 */

const FULL_DRAFT = {
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
    // **AIがここに書いても、本人の答えで上書きされる**
    fields: ['AIが勝手に決めた分野'],
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
    // **AIがここに書いても、本人の答えで上書きされる**
    exitCriteria: 'AIが勝手に決めたやめる条件',
  },
};

function providerReturning(text: string): AiProvider {
  return {
    complete: vi.fn(async () => ({
      text,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      provider: 'test',
      model: 'test',
    })),
  } as unknown as AiProvider;
}

const ANSWERS = {
  fields: ['格安SIM', '通信費の節約'],
  audience: '一人暮らしを始めたばかりの人',
  exitCriteria: '3か月やって月1,000円に届かなければやめる',
};

function draft(text = JSON.stringify(FULL_DRAFT)) {
  return draftPersonaFromAnswers(ANSWERS, {
    provider: providerReturning(text),
  });
}

describe('残りを埋める', () => {
  it('23項目ぶんの形が返る', async () => {
    const result = await draft();

    expect(result.identity.tone.style).toBe('やわらかい説明口調');
    expect(result.audience.knowledgeLevel).toBe('beginner');
    expect(result.business.kpis).toEqual(['クリック数']);
  });

  it('コードフェンス付きでも読む', async () => {
    const result = await draft(
      '```json\n' + JSON.stringify(FULL_DRAFT) + '\n```',
    );

    expect(result.name).toBe('節約の人');
  });
});

/**
 * **本人が答えたものは本人のもの。** AIが「もっと良い言い方」に
 * 直してしまうと、本人が決めたはずのものが本人のものでなくなる。
 */
describe('答えた3つを書き換えない', () => {
  it('専門領域は答えのまま', async () => {
    const result = await draft();

    expect(result.expertise.fields).toEqual(['格安SIM', '通信費の節約']);
  });

  /**
   * **ここが一番大事。** ROADMAP が「やめる条件を先に決める」と
   * しているのは、後から決めるとかけた時間に引きずられるから。
   * **AIが書いた条件では、その仕掛けが無意味になる。**
   */
  it('やめる条件は答えのまま', async () => {
    const result = await draft();

    expect(result.business.exitCriteria).toBe(
      '3か月やって月1,000円に届かなければやめる',
    );
  });

  it('前後の空白を落として使う', async () => {
    const result = await draftPersonaFromAnswers(
      {
        fields: ['  格安SIM  ', '', '  '],
        audience: '一人暮らし',
        exitCriteria: '  3か月で見直す  ',
      },
      { provider: providerReturning(JSON.stringify(FULL_DRAFT)) },
    );

    expect(result.expertise.fields).toEqual(['格安SIM']);
    expect(result.business.exitCriteria).toBe('3か月で見直す');
  });
});

/** **聞く3つは省けない。** 省くと30ブログが全部似る（Q-058） */
describe('答えが足りないとき', () => {
  it('専門領域が空なら断る', async () => {
    await expect(
      draftPersonaFromAnswers(
        { ...ANSWERS, fields: ['  '] },
        { provider: providerReturning('{}') },
      ),
    ).rejects.toThrow(/何について書きたいか/);
  });

  it('読者が空なら断る', async () => {
    await expect(
      draftPersonaFromAnswers(
        { ...ANSWERS, audience: '   ' },
        { provider: providerReturning('{}') },
      ),
    ).rejects.toThrow(/誰に向けて/);
  });

  it('やめる条件が空なら断る', async () => {
    await expect(
      draftPersonaFromAnswers(
        { ...ANSWERS, exitCriteria: '' },
        { provider: providerReturning('{}') },
      ),
    ).rejects.toThrow(/やめる条件/);
  });

  /** **AIを呼ぶ前に断る。** 足りないと分かっている呼び出しに費用を払わない */
  it('足りなければAIを呼ばない', async () => {
    const provider = providerReturning('{}');

    await expect(
      draftPersonaFromAnswers({ ...ANSWERS, fields: [] }, { provider }),
    ).rejects.toThrow();

    expect(provider.complete).not.toHaveBeenCalled();
  });
});

/**
 * **読めない下書きを通さない。** 通すと、23項目のうちどこかが
 * 壊れた分身がそのまま記事を書く。
 */
describe('下書きが読めないとき', () => {
  it('JSONでなければ手入力を案内する', async () => {
    await expect(draft('秘密のような何か')).rejects.toThrow(/手で入力/);
  });

  it('項目が足りなければ断る', async () => {
    await expect(draft(JSON.stringify({ name: '節約の人' }))).rejects.toThrow(
      /手で入力/,
    );
  });

  it('知らない絵文字の段は受け取らない', async () => {
    const broken = {
      ...FULL_DRAFT,
      identity: {
        ...FULL_DRAFT.identity,
        tone: { ...FULL_DRAFT.identity.tone, emojiLevel: 'たくさん' },
      },
    };

    await expect(draft(JSON.stringify(broken))).rejects.toThrow(/手で入力/);
  });

  it('知らない読者の詳しさは受け取らない', async () => {
    const broken = {
      ...FULL_DRAFT,
      audience: { ...FULL_DRAFT.audience, knowledgeLevel: 'ふつう' },
    };

    await expect(draft(JSON.stringify(broken))).rejects.toThrow(/手で入力/);
  });

  /** **空の配列を通さない。** 通ると、AIが参照できる材料が無い分身になる */
  it('空の一覧は受け取らない', async () => {
    const broken = {
      ...FULL_DRAFT,
      audience: { ...FULL_DRAFT.audience, problems: [] },
    };

    await expect(draft(JSON.stringify(broken))).rejects.toThrow(/手で入力/);
  });
});

/**
 * **30ブログが全部同じ文体になると、実験の一次データとして意味を失う。**
 * 下書きなので少し振れてよい。
 */
describe('AIの呼び方', () => {
  it('温度を0にしない', async () => {
    const provider = providerReturning(JSON.stringify(FULL_DRAFT));

    await draftPersonaFromAnswers(ANSWERS, { provider });

    const call = vi.mocked(provider.complete).mock.calls[0]?.[0];

    expect(call?.temperature ?? 0).toBeGreaterThan(0);
  });

  it('答えた3つをそのまま渡す', async () => {
    const provider = providerReturning(JSON.stringify(FULL_DRAFT));

    await draftPersonaFromAnswers(ANSWERS, { provider });

    const call = vi.mocked(provider.complete).mock.calls[0]?.[0];
    const sent = call?.messages[0]?.content ?? '';

    expect(sent).toContain('格安SIM');
    expect(sent).toContain('一人暮らしを始めたばかりの人');
    expect(sent).toContain('3か月やって月1,000円');
  });
});
