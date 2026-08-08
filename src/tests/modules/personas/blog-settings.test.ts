import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  HEADING_DEPTH_MAX,
  HEADING_DEPTH_MIN,
  LEAD_LENGTH_MAX,
  LEAD_LENGTH_MIN,
  PERSONA_ERROR_CODES,
  normalizeTargetReader,
  normalizeToneOverride,
  normalizeWritingRules,
  resolveEffectivePersona,
  type AppBlogPersonaSetting,
  type AppUserPersona,
} from '@/modules/personas';

/**
 * ブログ別設定と重ね合わせ（TASKS D-5、DATA_MODEL 3章）。
 *
 * 完了条件は「**ブログ別の上書き設定が保存される**」。ここで確かめるのは
 * **`tone_override` の未指定項目が共通人格を継承するか**。
 */

const TONE = {
  style: 'やわらかい語り口',
  emojiLevel: 'low' as const,
  lineBreak: 'short' as const,
  politeness: 'ですます',
};

const PERSONA: AppUserPersona = {
  id: 'persona-1',
  userId: 'user-1',
  baseProfile: {
    ageRange: '30代',
    position: '会社員',
    firstPerson: '私',
    background: '美容が好き',
  },
  tone: TONE,
  values: { priorities: ['正直さ'], avoid: ['煽り'] },
  ngExpressions: ['絶対に'],
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
};

const TARGET_READER = {
  ageRange: '20代',
  situation: '初めて選ぶ',
  knowledgeLevel: 'beginner' as const,
};

const WRITING_RULES = {
  headingDepth: 3,
  leadLength: 120,
  bulletFrequency: 'mid' as const,
};

function setting(
  overrides: Partial<AppBlogPersonaSetting> = {},
): AppBlogPersonaSetting {
  return {
    id: 'setting-1',
    blogId: 'blog-1',
    penName: 'あおい',
    toneOverride: {},
    targetReader: TARGET_READER,
    allowedExperiences: [],
    ngTopics: ['医療行為'],
    writingRules: WRITING_RULES,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
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

describe('normalizeToneOverride', () => {
  /**
   * **指定された項目だけを残す。** `undefined` の項目を入れて保存すると、
   * 「上書きしない」と「空で上書きする」の区別が付かなくなる。
   */
  it('指定された項目だけを残す', () => {
    expect(normalizeToneOverride({ emojiLevel: 'none' })).toEqual({
      emojiLevel: 'none',
    });
  });

  it.each([[undefined], [null], [{}]])('%o なら空', (value) => {
    expect(normalizeToneOverride(value)).toEqual({});
  });

  it('4項目すべてを指定できる', () => {
    expect(normalizeToneOverride(TONE)).toEqual(TONE);
  });

  it('知らない値を拒否する', () => {
    expect(codeOf(() => normalizeToneOverride({ emojiLevel: 'high' }))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });

  it('オブジェクトでない値を拒否する', () => {
    expect(codeOf(() => normalizeToneOverride('やわらかく'))).toBe(
      PERSONA_ERROR_CODES.invalidPersona,
    );
  });
});

describe('normalizeTargetReader', () => {
  it('3項目を整える', () => {
    expect(normalizeTargetReader(TARGET_READER)).toEqual(TARGET_READER);
  });

  it.each([['beginner'], ['intermediate'], ['advanced']])(
    '知識レベル %s を通す',
    (knowledgeLevel) => {
      expect(
        normalizeTargetReader({ ...TARGET_READER, knowledgeLevel })
          .knowledgeLevel,
      ).toBe(knowledgeLevel);
    },
  );

  it.each([['expert'], ['BEGINNER'], [null]])(
    '知らない知識レベル %o を拒否する',
    (knowledgeLevel) => {
      expect(
        codeOf(() =>
          normalizeTargetReader({ ...TARGET_READER, knowledgeLevel }),
        ),
      ).toBe(PERSONA_ERROR_CODES.invalidPersona);
    },
  );

  it('項目が欠けていれば拒否する', () => {
    expect(
      codeOf(() => normalizeTargetReader({ knowledgeLevel: 'beginner' })),
    ).toBe(PERSONA_ERROR_CODES.invalidPersona);
  });
});

describe('normalizeWritingRules', () => {
  it('3項目を整える', () => {
    expect(normalizeWritingRules(WRITING_RULES)).toEqual(WRITING_RULES);
  });

  it.each([[HEADING_DEPTH_MIN - 1], [HEADING_DEPTH_MAX + 1], [2.5], ['3']])(
    '見出しの深さ %o を拒否する',
    (headingDepth) => {
      expect(
        codeOf(() => normalizeWritingRules({ ...WRITING_RULES, headingDepth })),
      ).toBe(PERSONA_ERROR_CODES.invalidPersona);
    },
  );

  it.each([[LEAD_LENGTH_MIN - 1], [LEAD_LENGTH_MAX + 1]])(
    'リード文の長さ %s を拒否する',
    (leadLength) => {
      expect(
        codeOf(() => normalizeWritingRules({ ...WRITING_RULES, leadLength })),
      ).toBe(PERSONA_ERROR_CODES.invalidPersona);
    },
  );

  it.each([['low'], ['mid'], ['high']])(
    '箇条書きの頻度 %s を通す',
    (bulletFrequency) => {
      expect(
        normalizeWritingRules({ ...WRITING_RULES, bulletFrequency })
          .bulletFrequency,
      ).toBe(bulletFrequency);
    },
  );

  it('範囲をメッセージに含める', () => {
    try {
      normalizeWritingRules({ ...WRITING_RULES, headingDepth: 9 });
    } catch (error) {
      expect((error as AppError).message).toContain(String(HEADING_DEPTH_MAX));
    }
  });
});

describe('resolveEffectivePersona（完了条件の中心）', () => {
  /** **未指定の項目は共通人格を継承する**（DATA_MODEL 3章） */
  it('上書きされた項目だけ差し替わる', () => {
    const result = resolveEffectivePersona(
      PERSONA,
      setting({ toneOverride: { emojiLevel: 'none' } }),
    );

    expect(result.tone).toEqual({ ...TONE, emojiLevel: 'none' });
    // 上書きしていない項目は共通人格のまま
    expect(result.tone.style).toBe(TONE.style);
    expect(result.tone.politeness).toBe(TONE.politeness);
  });

  it('上書きが空なら共通人格そのまま', () => {
    expect(resolveEffectivePersona(PERSONA, setting()).tone).toEqual(TONE);
  });

  it('4項目すべて上書きできる', () => {
    const override = {
      style: 'きびきび',
      emojiLevel: 'none' as const,
      lineBreak: 'normal' as const,
      politeness: 'である',
    };

    expect(
      resolveEffectivePersona(PERSONA, setting({ toneOverride: override }))
        .tone,
    ).toEqual(override);
  });

  it('ブログ別の項目を載せる', () => {
    const result = resolveEffectivePersona(PERSONA, setting());

    expect(result.penName).toBe('あおい');
    expect(result.targetReader).toEqual(TARGET_READER);
    expect(result.writingRules).toEqual(WRITING_RULES);
    expect(result.ngTopics).toEqual(['医療行為']);
  });

  // 共通人格の側は上書きの対象外
  it('共通人格の項目はそのまま渡る', () => {
    const result = resolveEffectivePersona(
      PERSONA,
      setting({ toneOverride: { emojiLevel: 'none' } }),
    );

    expect(result.baseProfile).toEqual(PERSONA.baseProfile);
    expect(result.values).toEqual(PERSONA.values);
    expect(result.ngExpressions).toEqual(PERSONA.ngExpressions);
  });

  /**
   * **設定前のブログでも記事は書けるべき。**
   * ブログ固有の項目が `null`／空になるだけ。
   */
  it('ブログ別設定が無くても組み立てられる', () => {
    const result = resolveEffectivePersona(PERSONA, null);

    expect(result.tone).toEqual(TONE);
    expect(result.penName).toBeNull();
    expect(result.targetReader).toBeNull();
    expect(result.writingRules).toBeNull();
    expect(result.ngTopics).toEqual([]);
  });
});
