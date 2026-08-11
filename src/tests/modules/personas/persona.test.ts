import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_PERSONAS,
  maxActivePersonas,
  normalizeCreatePersona,
  normalizeUpdatePersona,
  PERSONA_ERROR_CODES,
} from '@/modules/personas';

/**
 * 分身の検証（TASKS A-2-R-2）。
 *
 * 4つの jsonb は**DBが中身を保証しない**。壊れた形のまま入ると、
 * 記事生成が読めない値を掴んで落ちる。
 */

const VALID = {
  name: '節約の人',
  personaType: 'SELF',
  identity: {
    name: 'まこと',
    firstPerson: '私',
    background: '30代の会社員。家計の見直しが趣味',
    tone: {
      style: 'やわらかい',
      emojiLevel: 'low',
      lineBreak: 'normal',
      politeness: 'です・ます',
    },
    values: { priorities: ['正確さ'], avoid: ['煽り'] },
    ngExpressions: ['絶対に儲かる'],
  },
  expertise: {
    fields: ['家計管理'],
    sources: ['総務省統計'],
    evaluationCriteria: ['実際に使ったか'],
  },
  audience: {
    ageRange: '30代',
    situation: '子育て中で出費が増えた',
    knowledgeLevel: 'beginner',
    problems: ['固定費が下がらない'],
    searchIntents: ['格安SIM 比較'],
  },
  business: {
    revenuePolicy: '使ったものだけ紹介する',
    monthlyGoalYen: 30_000,
    kpis: ['成果件数'],
    exitCriteria: '3か月で表示回数が伸びなければ畳む',
  },
};

function invalid(overrides: Record<string, unknown>): unknown {
  return { ...VALID, ...overrides };
}

describe('normalizeCreatePersona', () => {
  it('妥当な入力をそのまま通す', () => {
    const result = normalizeCreatePersona(VALID);

    expect(result.name).toBe('節約の人');
    expect(result.identity.firstPerson).toBe('私');
    expect(result.business.monthlyGoalYen).toBe(30_000);
  });

  it('前後の空白を落とす', () => {
    const result = normalizeCreatePersona(invalid({ name: '  節約の人  ' }));

    expect(result.name).toBe('節約の人');
  });

  /** **重複を落とす。** プロンプトが無駄に長くなる（AI費用に効く） */
  it('配列の重複を落とす', () => {
    const result = normalizeCreatePersona(
      invalid({
        expertise: { ...VALID.expertise, fields: ['家計管理', '家計管理'] },
      }),
    );

    expect(result.expertise.fields).toEqual(['家計管理']);
  });

  /** **専門が空の分身は、何を書く人なのかが決まらない** */
  it('専門領域が空なら拒む', () => {
    expect(() =>
      normalizeCreatePersona(
        invalid({ expertise: { ...VALID.expertise, fields: [] } }),
      ),
    ).toThrow();
  });

  /** **撤退条件は必須。** 後から決めると沈んだ費用に引きずられる */
  it('撤退条件が空なら拒む', () => {
    expect(() =>
      normalizeCreatePersona(
        invalid({ business: { ...VALID.business, exitCriteria: '  ' } }),
      ),
    ).toThrow();
  });

  it.each([
    { label: '入力が無い', input: null },
    { label: '種類が不正', input: invalid({ personaType: 'OTHER' }) },
    {
      label: '知識レベルが不正',
      input: invalid({
        audience: { ...VALID.audience, knowledgeLevel: 'expert' },
      }),
    },
    {
      label: '絵文字の量が不正',
      input: invalid({
        identity: {
          ...VALID.identity,
          tone: { ...VALID.identity.tone, emojiLevel: 'high' },
        },
      }),
    },
    {
      label: '目標額が負',
      input: invalid({ business: { ...VALID.business, monthlyGoalYen: -1 } }),
    },
    {
      label: '目標額が小数',
      input: invalid({ business: { ...VALID.business, monthlyGoalYen: 1.5 } }),
    },
    { label: '名前が長すぎる', input: invalid({ name: 'あ'.repeat(51) }) },
  ])('$label なら拒む', ({ input }) => {
    try {
      normalizeCreatePersona(input);
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        PERSONA_ERROR_CODES.invalidPersona,
      );
    }
  });

  /** **理由を返す。** 「不正です」だけでは直しようがない */
  it('拒む理由を文言に含める', () => {
    try {
      normalizeCreatePersona(invalid({ name: '' }));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('分身の名前');
    }
  });
});

describe('normalizeUpdatePersona', () => {
  /** **渡さなかった項目は触らない。** 既定値で上書きすると設定が消える */
  it('渡した項目だけを返す', () => {
    const result = normalizeUpdatePersona({ name: '別の名前' });

    expect(result).toEqual({ name: '別の名前' });
    expect(result.identity).toBeUndefined();
  });

  it('空のオブジェクトを許す', () => {
    expect(normalizeUpdatePersona({})).toEqual({});
  });

  it('渡した項目の中身は検証する', () => {
    expect(() => normalizeUpdatePersona({ personaType: 'OTHER' })).toThrow();
  });
});

/**
 * **習熟に合わせて開ける**（ROADMAP 5章）。最初から3体を渡すと、
 * 承認が溜まって止まる。
 */
describe('maxActivePersonas', () => {
  it.each([
    { days: 0, expected: 1 },
    { days: 29, expected: 1 },
    { days: 30, expected: 2 },
    { days: 59, expected: 2 },
    { days: 60, expected: 3 },
    { days: 120, expected: 3 },
  ])('$days 日で $expected 体', ({ days, expected }) => {
    expect(maxActivePersonas(days)).toBe(expected);
  });

  it('上限を超えない', () => {
    expect(maxActivePersonas(10_000)).toBe(MAX_ACTIVE_PERSONAS);
  });
});
