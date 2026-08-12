/**
 * 人格まわりの共通の検証（TASKS D-4・D-5、DATA_MODEL 3章）。
 *
 * jsonb は **DBが中身を保証しない**ので、保存の直前にここで形を固定する。
 * 壊れた形のまま入ると、記事生成（E-8）が読めない値を掴んで落ちる。
 *
 * **旧 `user_personas` 専用の検証は A-2-R-2f で消した。** 分身の検証は
 * `persona.ts` が持つ。ここに残っているのは `blog_persona_settings` と
 * 分身の両方から使うもの。
 */

import { invalidPersonaError } from './errors';
import {
  EMOJI_LEVELS,
  LINE_BREAK_STYLES,
  type EmojiLevel,
  type LineBreakStyle,
  type PersonaValues,
  type Tone,
} from './types';

export const PERSONA_TEXT_MAX_LENGTH = 200;
export const PERSONA_LIST_MAX = 20;

function assertText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw invalidPersonaError(`${label}を文字列で入力してください`);
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidPersonaError(`${label}が空です`);
  }

  if (trimmed.length > max) {
    throw invalidPersonaError(`${label}は${max}文字以内で入力してください`);
  }

  return trimmed;
}

/**
 * 文字列の配列を整える。
 *
 * **重複を落とす。** 同じNG表現が2つ入っていても意味が無く、
 * プロンプトが無駄に長くなる（AI費用に効く）。
 */
function assertList(
  values: unknown,
  label: string,
  max = PERSONA_LIST_MAX,
): string[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw invalidPersonaError(`${label}を配列で指定してください`);
  }

  if (values.length > max) {
    throw invalidPersonaError(`${label}は${max}件までです`);
  }

  const normalized = values.map((value, index) =>
    assertText(value, `${label}${index + 1}`, PERSONA_TEXT_MAX_LENGTH),
  );

  return [...new Set(normalized)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEmojiLevel(value: unknown): value is EmojiLevel {
  return (
    typeof value === 'string' &&
    (EMOJI_LEVELS as readonly string[]).includes(value)
  );
}

export function isLineBreakStyle(value: unknown): value is LineBreakStyle {
  return (
    typeof value === 'string' &&
    (LINE_BREAK_STYLES as readonly string[]).includes(value)
  );
}

/** @throws {AppError} 形が違う・知らない値 */
export function normalizeTone(value: unknown): Tone {
  if (!isRecord(value)) {
    throw invalidPersonaError('文体を指定してください');
  }

  if (!isEmojiLevel(value['emojiLevel'])) {
    throw invalidPersonaError(
      `絵文字の量は ${EMOJI_LEVELS.join(' / ')} のいずれかで指定してください`,
    );
  }

  if (!isLineBreakStyle(value['lineBreak'])) {
    throw invalidPersonaError(
      `改行は ${LINE_BREAK_STYLES.join(' / ')} のいずれかで指定してください`,
    );
  }

  return {
    style: assertText(value['style'], '文体', PERSONA_TEXT_MAX_LENGTH),
    emojiLevel: value['emojiLevel'],
    lineBreak: value['lineBreak'],
    politeness: assertText(
      value['politeness'],
      '丁寧さ',
      PERSONA_TEXT_MAX_LENGTH,
    ),
  };
}

/** @throws {AppError} 形が違う */
export function normalizeValues(value: unknown): PersonaValues {
  if (!isRecord(value)) {
    throw invalidPersonaError('価値観を指定してください');
  }

  return {
    priorities: assertList(value['priorities'], '大事にすること'),
    avoid: assertList(value['avoid'], '避けること'),
  };
}
