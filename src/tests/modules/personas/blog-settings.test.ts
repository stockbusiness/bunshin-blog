import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  HEADING_DEPTH_MAX,
  HEADING_DEPTH_MIN,
  LEAD_LENGTH_MAX,
  LEAD_LENGTH_MIN,
  PERSONA_ERROR_CODES,
  normalizeToneOverride,
  normalizeWritingRules,
  resolveEffectivePersona,
  type AppBlogPersonaSetting,
  type AppPersona,
} from '@/modules/personas';

/**
 * ブログ別設定と重ね合わせ（TASKS D-5、A-2-R-2d、DATA_MODEL 3章）。
 *
 * 完了条件は「**ブログ別の上書き設定が保存される**」。ここで確かめるのは
 * **`tone_override` の未指定項目が分身のものを継承するか**。
 *
 * **重ねる相手は `Persona`**（A-2-R-2d）。旧 `user_personas` ではない。
 * 読者像（`audience`）は分身が持ち、媒体側から上書きできない。
 */

const TONE = {
  style: 'やわらかい語り口',
  emojiLevel: 'low' as const,
  lineBreak: 'short' as const,
  politeness: 'ですます',
};

const AUDIENCE = {
  ageRange: '20代',
  situation: '初めて選ぶ',
  knowledgeLevel: 'beginner' as const,
  problems: ['どれを選べばいいか分からない'],
  searchIntents: ['化粧水 比較'],
};

const PERSONA: AppPersona = {
  id: 'persona-1',
  userId: 'user-1',
  name: '美容の人',
  personaType: 'SELF',
  identity: {
    name: 'あおい',
    firstPerson: '私',
    background: '美容が好き',
    tone: TONE,
    values: { priorities: ['正直さ'], avoid: ['煽り'] },
    ngExpressions: ['絶対に'],
  },
  expertise: {
    fields: ['スキンケア'],
    sources: ['成分表示'],
    evaluationCriteria: ['自分で使ったか'],
  },
  audience: AUDIENCE,
  business: {
    revenuePolicy: '使ったものだけ紹介する',
    monthlyGoalYen: 30_000,
    kpis: ['成果件数'],
    exitCriteria: '3か月で表示回数が伸びなければ畳む',
  },
  status: 'ACTIVE',
  activatedAt: new Date('2026-08-01T00:00:00Z'),
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
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
  /** **未指定の項目は分身のものを継承する**（DATA_MODEL 3章） */
  it('上書きされた項目だけ差し替わる', () => {
    const result = resolveEffectivePersona(
      PERSONA,
      setting({ toneOverride: { emojiLevel: 'none' } }),
    );

    expect(result.tone).toEqual({ ...TONE, emojiLevel: 'none' });
    // 上書きしていない項目は分身のまま
    expect(result.tone.style).toBe(TONE.style);
    expect(result.tone.politeness).toBe(TONE.politeness);
  });

  it('上書きが空なら分身のまま', () => {
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
    expect(result.writingRules).toEqual(WRITING_RULES);
    expect(result.ngTopics).toEqual(['医療行為']);
  });

  // 分身の側は上書きの対象外
  it('分身の項目はそのまま渡る', () => {
    const result = resolveEffectivePersona(
      PERSONA,
      setting({ toneOverride: { emojiLevel: 'none' } }),
    );

    expect(result.personaId).toBe(PERSONA.id);
    expect(result.name).toBe(PERSONA.name);
    expect(result.firstPerson).toBe(PERSONA.identity.firstPerson);
    expect(result.background).toBe(PERSONA.identity.background);
    expect(result.values).toEqual(PERSONA.identity.values);
    expect(result.ngExpressions).toEqual(PERSONA.identity.ngExpressions);
    expect(result.expertise).toEqual(PERSONA.expertise);
  });

  /**
   * **読者像は分身が持つ**（A-2-R-2d）。旧 `blog_persona_settings.target_reader`
   * を置き換えたもので、媒体側から上書きできない。
   */
  it('読者像は分身のものが渡り、媒体では上書きされない', () => {
    expect(resolveEffectivePersona(PERSONA, setting()).audience).toEqual(
      AUDIENCE,
    );
    expect(resolveEffectivePersona(PERSONA, null).audience).toEqual(AUDIENCE);
  });

  /**
   * **設定前のブログでも記事は書けるべき。**
   * ブログ固有の項目が `null`／空になるだけ。
   */
  it('ブログ別設定が無くても組み立てられる', () => {
    const result = resolveEffectivePersona(PERSONA, null);

    expect(result.tone).toEqual(TONE);
    expect(result.penName).toBeNull();
    expect(result.writingRules).toBeNull();
    expect(result.ngTopics).toEqual([]);
  });
});
