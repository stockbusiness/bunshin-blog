import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  PERSONA_ERROR_CODES,
  PERSONA_LIST_MAX,
  PERSONA_TEXT_MAX_LENGTH,
  normalizeTone,
  normalizeValues,
} from '@/modules/personas';

/**
 * 人格まわりの共通の検証（TASKS D-4・D-5、DATA_MODEL 3章）。
 *
 * `jsonb` は**DBが中身を保証しない**。壊れた形のまま入ると、記事生成（E-8）が
 * 読めない値を掴んで落ちる。
 *
 * **旧 `user_personas` 専用の検証は A-2-R-2f で消した。** 分身の検証は
 * `persona.test.ts` の担当。ここに残るのは `tone` と `values` —
 * `blog_persona_settings` の上書きと分身の両方から使う。
 */

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

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

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
