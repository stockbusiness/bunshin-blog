/**
 * ユーザー共通人格の検証（TASKS D-4、DATA_MODEL 3章）。
 *
 * `base_profile` `tone` `values` は `jsonb`。**DBは中身を保証しない**ので、
 * 保存の直前にここで形を固定する。壊れた形のまま入ると、記事生成（E-8）が
 * 読めない値を掴んで落ちる。
 */

import { invalidPersonaError } from './errors';
import {
  EMOJI_LEVELS,
  LINE_BREAK_STYLES,
  type BaseProfile,
  type CreateUserPersonaInput,
  type EmojiLevel,
  type LineBreakStyle,
  type PersonaValues,
  type Tone,
  type UpdateUserPersonaInput,
} from './types';

export const PERSONA_TEXT_MAX_LENGTH = 200;
export const PERSONA_BACKGROUND_MAX_LENGTH = 1000;
export const FIRST_PERSON_MAX_LENGTH = 10;
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

/** @throws {AppError} 形が違う */
export function normalizeBaseProfile(value: unknown): BaseProfile {
  if (!isRecord(value)) {
    throw invalidPersonaError('基本プロフィールを指定してください');
  }

  return {
    ageRange: assertText(value['ageRange'], '年代', PERSONA_TEXT_MAX_LENGTH),
    position: assertText(value['position'], '立場', PERSONA_TEXT_MAX_LENGTH),
    firstPerson: assertText(
      value['firstPerson'],
      '一人称',
      FIRST_PERSON_MAX_LENGTH,
    ),
    background: assertText(
      value['background'],
      '背景',
      PERSONA_BACKGROUND_MAX_LENGTH,
    ),
  };
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

export interface NormalizedUserPersona {
  baseProfile: BaseProfile;
  tone: Tone;
  values: PersonaValues;
  ngExpressions: string[];
}

/** @throws {AppError} 入力の不備 */
export function normalizeCreateUserPersona(
  input: CreateUserPersonaInput,
): NormalizedUserPersona {
  return {
    baseProfile: normalizeBaseProfile(input.baseProfile),
    tone: normalizeTone(input.tone),
    values: normalizeValues(input.values),
    ngExpressions: assertList(input.ngExpressions, 'NG表現'),
  };
}

/**
 * 編集入力を整える。
 *
 * **渡された項目だけを返す。** `undefined` は「変えない」を意味する。
 * 項目を渡した場合は、その項目の中身をすべて指定する（部分更新はしない）。
 */
export function normalizeUpdateUserPersona(
  input: UpdateUserPersonaInput,
): Partial<NormalizedUserPersona> {
  const data: Partial<NormalizedUserPersona> = {};

  if (input.baseProfile !== undefined) {
    data.baseProfile = normalizeBaseProfile(input.baseProfile);
  }

  if (input.tone !== undefined) {
    data.tone = normalizeTone(input.tone);
  }

  if (input.values !== undefined) {
    data.values = normalizeValues(input.values);
  }

  if (input.ngExpressions !== undefined) {
    data.ngExpressions = assertList(input.ngExpressions, 'NG表現');
  }

  return data;
}
