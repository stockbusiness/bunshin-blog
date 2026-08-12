import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PersonaForm } from '@/app/liff/personas/_components/persona-form';
import type { PersonaInput } from '@/app/liff/_lib/personas-api';

/**
 * 分身の入力フォーム（TASKS D-14）の描画と入力（TASKS B-9）。
 *
 * **検証の規則はここで確かめない**（サーバーが持つ）。ここで見るのは
 * **入力した値がそのままの形で送られるか** — 特に改行区切りの一覧。
 */

function initial(overrides: Partial<PersonaInput> = {}): PersonaInput {
  return {
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
    expertise: { fields: ['家計管理'], sources: [], evaluationCriteria: [] },
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
    ...overrides,
  };
}

describe('分身のフォーム', () => {
  it('渡した値が初期表示される', () => {
    render(
      <PersonaForm
        initial={initial()}
        submitLabel="保存する"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('分身の呼び名')).toHaveValue('節約の人');
    expect(screen.getByLabelText('一人称')).toHaveValue('私');
    // 配列は改行区切りで出す
    expect(screen.getByLabelText('専門領域')).toHaveValue('家計管理');
  });

  it('初期値が無ければ空で始まる', () => {
    render(
      <PersonaForm
        submitLabel="保存する"
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('分身の呼び名')).toHaveValue('');
    expect(screen.getByLabelText('月にいくら目指すか（円）')).toHaveValue(0);
  });

  it('入力した値をそのまま渡す', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <PersonaForm
        initial={initial()}
        submitLabel="保存する"
        submitting={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );

    await user.clear(screen.getByLabelText('分身の呼び名'));
    await user.type(screen.getByLabelText('分身の呼び名'), 'ガジェットの人');
    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ガジェットの人' }),
    );
  });

  /**
   * **改行区切りを配列にする。** 空行は落とす —
   * 残すと「何件入れたか」と実際の件数が合わなくなる
   */
  it('一覧は改行で分け、空行を落とす', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <PersonaForm
        initial={initial()}
        submitLabel="保存する"
        submitting={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );

    const field = screen.getByLabelText('専門領域');
    await user.clear(field);
    await user.type(field, '家計管理\n\n 格安SIM ');
    await user.click(screen.getByRole('button', { name: '保存する' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        expertise: expect.objectContaining({ fields: ['家計管理', '格安SIM'] }),
      }),
    );
  });

  it('保存中はボタンを押せない', () => {
    render(
      <PersonaForm
        initial={initial()}
        submitLabel="保存する"
        submitting={true}
        error={null}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: '保存しています' }),
    ).toBeDisabled();
  });

  /** **サーバーの文言をそのまま出す。** 言い換えると理由が伝わらなくなる */
  it('エラーはそのまま出す', () => {
    render(
      <PersonaForm
        initial={initial()}
        submitLabel="保存する"
        submitting={false}
        error="専門領域を1件以上入力してください"
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '専門領域を1件以上入力してください',
    );
  });
});
