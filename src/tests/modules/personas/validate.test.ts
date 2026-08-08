import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  FIRST_PERSON_MAX_LENGTH,
  PERSONA_ERROR_CODES,
  PERSONA_LIST_MAX,
  PERSONA_TEXT_MAX_LENGTH,
  normalizeBaseProfile,
  normalizeCreateUserPersona,
  normalizeTone,
  normalizeUpdateUserPersona,
  normalizeValues,
  type CreateUserPersonaInput,
} from '@/modules/personas';

/**
 * ユーザー共通人格の検証（TASKS D-4、DATA_MODEL 3章）。
 *
 * `jsonb` は**DBが中身を保証しない**。壊れた形のまま入ると、記事生成（E-8）が
 * 読めない値を掴んで落ちる。
 */

const BASE_PROFILE = {
  ageRange: '30代',
  position: '会社員',
  firstPerson: '私',
  background: '美容の情報を集めるのが好き',
};

const TONE = {
  style: 'やわらかい語り口',
  emojiLevel: 'low' as const,
  lineBreak: 'short' as const,
  politeness: 'ですます',
};

const VALUES = {
  priorities: ['正直さ', '分かりやすさ'],
  avoid: ['煽り'],
};

function input(
  overrides: Partial<CreateUserPersonaInput> = {},
): CreateUserPersonaInput {
  return {
    baseProfile: BASE_PROFILE,
    tone: TONE,
    values: VALUES,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('normalizeBaseProfile', () => {
  it('4項目を整える', () => {
    expect(normalizeBaseProfile(BASE_PROFILE)).toEqual(BASE_PROFILE);
  });

  it('前後の空白を落とす', () => {
    expect(
      normalizeBaseProfile({ ...BASE_PROFILE, position: '  会社員  ' })
        .position,
    ).toBe('会社員');
  });

  it.each([
    ['年代', 'ageRange'],
    ['立場', 'position'],
    ['一人称', 'firstPerson'],
    ['背景', 'background'],
  ])('%s が無ければ拒否する', (_label, key) => {
    const value: Record<string, unknown> = { ...BASE_PROFILE };
    delete value[key];

    expect(codeOf(() => normalizeBaseProfile(value))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });

  it.each([[null], [undefined], ['文字列'], [[]], [42]])(
    'オブジェクトでない %o を拒否する',
    (value) => {
      expect(codeOf(() => normalizeBaseProfile(value))).toBe(
        PERSONA_ERROR_CODES.invalidPersona,
      );
    },
  );

  it('文字列でない値を拒否する', () => {
    expect(
      codeOf(() => normalizeBaseProfile({ ...BASE_PROFILE, ageRange: 30 })),
    ).toBe(PERSONA_ERROR_CODES.invalidPersona);
  });

  // 一人称は「私」「僕」程度。長い文が入るのは入力の取り違え
  it('一人称の長さを制限する', () => {
    expect(
      codeOf(() =>
        normalizeBaseProfile({
          ...BASE_PROFILE,
          firstPerson: 'あ'.repeat(FIRST_PERSON_MAX_LENGTH + 1),
        }),
      ),
    ).toBe(PERSONA_ERROR_CODES.invalidPersona);
  });
});

describe('normalizeTone', () => {
  it('4項目を整える', () => {
    expect(normalizeTone(TONE)).toEqual(TONE);
  });

  it.each([['none'], ['low'], ['mid']])(
    '絵文字の量 %s を通す',
    (emojiLevel) => {
      expect(normalizeTone({ ...TONE, emojiLevel }).emojiLevel).toBe(
        emojiLevel,
      );
    },
  );

  it.each([['high'], ['NONE'], [''], [null]])(
    '知らない絵文字の量 %o を拒否する',
    (emojiLevel) => {
      expect(codeOf(() => normalizeTone({ ...TONE, emojiLevel }))).toBe(
        PERSONA_ERROR_CODES.invalidPersona,
      );
    },
  );

  it.each([['short'], ['normal']])('改行 %s を通す', (lineBreak) => {
    expect(normalizeTone({ ...TONE, lineBreak }).lineBreak).toBe(lineBreak);
  });

  it.each([['long'], ['SHORT'], [null]])(
    '知らない改行 %o を拒否する',
    (lineBreak) => {
      expect(codeOf(() => normalizeTone({ ...TONE, lineBreak }))).toBe(
        PERSONA_ERROR_CODES.invalidPersona,
      );
    },
  );

  // 何を指定すればよいかが分からないと直しようがない
  it('選べる値をメッセージに含める', () => {
    try {
      normalizeTone({ ...TONE, emojiLevel: 'high' });
    } catch (error) {
      expect((error as AppError).message).toContain('none');
    }
  });
});

describe('normalizeValues', () => {
  it('2つの配列を整える', () => {
    expect(normalizeValues(VALUES)).toEqual(VALUES);
  });

  it('未指定なら空の配列', () => {
    expect(normalizeValues({})).toEqual({ priorities: [], avoid: [] });
  });

  // プロンプトが無駄に長くなる（AI費用に効く）
  it('重複を落とす', () => {
    expect(
      normalizeValues({ priorities: ['正直さ', '正直さ'], avoid: [] })
        .priorities,
    ).toEqual(['正直さ']);
  });

  it('件数を制限する', () => {
    const priorities = Array.from(
      { length: PERSONA_LIST_MAX + 1 },
      (_, index) => `方針${index}`,
    );

    expect(codeOf(() => normalizeValues({ priorities, avoid: [] }))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });

  it('配列でない値を拒否する', () => {
    expect(codeOf(() => normalizeValues({ priorities: '正直さ' }))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });

  it('長すぎる要素を拒否する', () => {
    expect(
      codeOf(() =>
        normalizeValues({
          priorities: ['あ'.repeat(PERSONA_TEXT_MAX_LENGTH + 1)],
        }),
      ),
    ).toBe(PERSONA_ERROR_CODES.invalidPersona);
  });
});

describe('normalizeCreateUserPersona', () => {
  it('NG表現が未指定なら空', () => {
    expect(normalizeCreateUserPersona(input()).ngExpressions).toEqual([]);
  });

  it('NG表現を整える', () => {
    expect(
      normalizeCreateUserPersona(
        input({ ngExpressions: ['絶対に', '  絶対に  ', '必ず'] }),
      ).ngExpressions,
    ).toEqual(['絶対に', '必ず']);
  });
});

describe('normalizeUpdateUserPersona', () => {
  it('渡された項目だけを返す', () => {
    expect(normalizeUpdateUserPersona({ tone: TONE })).toEqual({ tone: TONE });
  });

  it('何も渡さなければ空を返す', () => {
    expect(normalizeUpdateUserPersona({})).toEqual({});
  });

  /**
   * **項目を渡したら、その中身はすべて指定する。**
   * 入れ子の一部だけを更新できるようにすると、「今どういう設定になって
   * いるか」が分からなくなる。部分上書きは D-5 の `tone_override` が担う。
   */
  it('項目の中身が欠けていれば拒否する', () => {
    expect(
      codeOf(() =>
        normalizeUpdateUserPersona({
          tone: { emojiLevel: 'low' } as CreateUserPersonaInput['tone'],
        }),
      ),
    ).toBe(PERSONA_ERROR_CODES.invalidPersona);
  });

  it('NG表現を空にできる', () => {
    expect(normalizeUpdateUserPersona({ ngExpressions: [] })).toEqual({
      ngExpressions: [],
    });
  });
});
