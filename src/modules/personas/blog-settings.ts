/**
 * ブログ別の人格設定と、共通人格との重ね合わせ（TASKS D-5、DATA_MODEL 3章）。
 *
 * ## 上書きの規則
 *
 * `tone_override` は `Partial<typeof tone>`。**未指定の項目は
 * `user_personas` を継承する。**
 *
 * 重ねる処理をここに1つだけ置く。呼び出し側（記事生成 E-8）に
 * 「共通とブログ別のどちらを見るか」を判断させると、**片方だけ見る経路が
 * いずれ生まれる**。
 *
 * DBを触らない純粋な処理。保存は `repository.ts` の担当。
 */

import { invalidPersonaError } from './errors';
import {
  BULLET_FREQUENCIES,
  EMOJI_LEVELS,
  KNOWLEDGE_LEVELS,
  LINE_BREAK_STYLES,
  type AppBlogPersonaSetting,
  type AppUserPersona,
  type BulletFrequency,
  type EffectivePersona,
  type KnowledgeLevel,
  type SaveBlogPersonaSettingInput,
  type TargetReader,
  type ToneOverride,
  type UpdateBlogPersonaSettingInput,
  type WritingRules,
} from './types';
import {
  PERSONA_LIST_MAX,
  PERSONA_TEXT_MAX_LENGTH,
  isEmojiLevel,
  isLineBreakStyle,
} from './validate';

export const PEN_NAME_MAX_LENGTH = 60;
/** 見出しの深さ。`h2`〜`h4` の範囲に収める */
export const HEADING_DEPTH_MIN = 2;
export const HEADING_DEPTH_MAX = 4;
/** リード文の長さ（文字数） */
export const LEAD_LENGTH_MIN = 40;
export const LEAD_LENGTH_MAX = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function assertList(values: unknown, label: string): string[] {
  if (values === undefined) {
    return [];
  }

  if (!Array.isArray(values)) {
    throw invalidPersonaError(`${label}を配列で指定してください`);
  }

  if (values.length > PERSONA_LIST_MAX) {
    throw invalidPersonaError(`${label}は${PERSONA_LIST_MAX}件までです`);
  }

  const normalized = values.map((value, index) =>
    assertText(value, `${label}${index + 1}`, PERSONA_TEXT_MAX_LENGTH),
  );

  return [...new Set(normalized)];
}

function assertInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidPersonaError(`${label}を整数で指定してください`);
  }

  if (value < min || value > max) {
    throw invalidPersonaError(`${label}は${min}〜${max}で指定してください`);
  }

  return value;
}

export function isKnowledgeLevel(value: unknown): value is KnowledgeLevel {
  return (
    typeof value === 'string' &&
    (KNOWLEDGE_LEVELS as readonly string[]).includes(value)
  );
}

export function isBulletFrequency(value: unknown): value is BulletFrequency {
  return (
    typeof value === 'string' &&
    (BULLET_FREQUENCIES as readonly string[]).includes(value)
  );
}

/**
 * 文体の上書きを整える。
 *
 * **指定された項目だけを残す。** `undefined` の項目を入れて保存すると、
 * 「上書きしない」と「空で上書きする」の区別が付かなくなる。
 *
 * @throws {AppError} 知らない値
 */
export function normalizeToneOverride(value: unknown): ToneOverride {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw invalidPersonaError('文体の上書きを指定してください');
  }

  const override: ToneOverride = {};

  if (value['style'] !== undefined) {
    override.style = assertText(
      value['style'],
      '文体',
      PERSONA_TEXT_MAX_LENGTH,
    );
  }

  if (value['emojiLevel'] !== undefined) {
    if (!isEmojiLevel(value['emojiLevel'])) {
      throw invalidPersonaError(
        `絵文字の量は ${EMOJI_LEVELS.join(' / ')} のいずれかで指定してください`,
      );
    }
    override.emojiLevel = value['emojiLevel'];
  }

  if (value['lineBreak'] !== undefined) {
    if (!isLineBreakStyle(value['lineBreak'])) {
      throw invalidPersonaError(
        `改行は ${LINE_BREAK_STYLES.join(' / ')} のいずれかで指定してください`,
      );
    }
    override.lineBreak = value['lineBreak'];
  }

  if (value['politeness'] !== undefined) {
    override.politeness = assertText(
      value['politeness'],
      '丁寧さ',
      PERSONA_TEXT_MAX_LENGTH,
    );
  }

  return override;
}

/** @throws {AppError} 形が違う・知らない値 */
export function normalizeTargetReader(value: unknown): TargetReader {
  if (!isRecord(value)) {
    throw invalidPersonaError('想定読者を指定してください');
  }

  if (!isKnowledgeLevel(value['knowledgeLevel'])) {
    throw invalidPersonaError(
      `読者の知識レベルは ${KNOWLEDGE_LEVELS.join(' / ')} のいずれかで指定してください`,
    );
  }

  return {
    ageRange: assertText(
      value['ageRange'],
      '読者の年代',
      PERSONA_TEXT_MAX_LENGTH,
    ),
    situation: assertText(
      value['situation'],
      '読者の状況',
      PERSONA_TEXT_MAX_LENGTH,
    ),
    knowledgeLevel: value['knowledgeLevel'],
  };
}

/** @throws {AppError} 形が違う・範囲外 */
export function normalizeWritingRules(value: unknown): WritingRules {
  if (!isRecord(value)) {
    throw invalidPersonaError('書き方のルールを指定してください');
  }

  if (!isBulletFrequency(value['bulletFrequency'])) {
    throw invalidPersonaError(
      `箇条書きの頻度は ${BULLET_FREQUENCIES.join(' / ')} のいずれかで指定してください`,
    );
  }

  return {
    headingDepth: assertInteger(
      value['headingDepth'],
      '見出しの深さ',
      HEADING_DEPTH_MIN,
      HEADING_DEPTH_MAX,
    ),
    leadLength: assertInteger(
      value['leadLength'],
      'リード文の長さ',
      LEAD_LENGTH_MIN,
      LEAD_LENGTH_MAX,
    ),
    bulletFrequency: value['bulletFrequency'],
  };
}

export interface NormalizedBlogPersonaSetting {
  penName: string;
  toneOverride: ToneOverride;
  targetReader: TargetReader;
  ngTopics: string[];
  writingRules: WritingRules;
}

/** @throws {AppError} 入力の不備 */
export function normalizeSaveBlogPersonaSetting(
  input: SaveBlogPersonaSettingInput,
): NormalizedBlogPersonaSetting {
  return {
    penName: assertText(input.penName, 'ペンネーム', PEN_NAME_MAX_LENGTH),
    toneOverride: normalizeToneOverride(input.toneOverride),
    targetReader: normalizeTargetReader(input.targetReader),
    ngTopics: assertList(input.ngTopics, 'NG話題'),
    writingRules: normalizeWritingRules(input.writingRules),
  };
}

/** 渡された項目だけを返す。`undefined` は「変えない」 */
export function normalizeUpdateBlogPersonaSetting(
  input: UpdateBlogPersonaSettingInput,
): Partial<NormalizedBlogPersonaSetting> {
  const data: Partial<NormalizedBlogPersonaSetting> = {};

  if (input.penName !== undefined) {
    data.penName = assertText(input.penName, 'ペンネーム', PEN_NAME_MAX_LENGTH);
  }

  if (input.toneOverride !== undefined) {
    data.toneOverride = normalizeToneOverride(input.toneOverride);
  }

  if (input.targetReader !== undefined) {
    data.targetReader = normalizeTargetReader(input.targetReader);
  }

  if (input.ngTopics !== undefined) {
    data.ngTopics = assertList(input.ngTopics, 'NG話題');
  }

  if (input.writingRules !== undefined) {
    data.writingRules = normalizeWritingRules(input.writingRules);
  }

  return data;
}

/**
 * 共通人格にブログ別の上書きを重ねる（記事生成 E-8 の入力）。
 *
 * **`tone_override` の未指定項目は共通人格を継承する**（DATA_MODEL 3章）。
 *
 * **ブログ別設定が無くても動く。** 設定前のブログでも記事は書けるべきで、
 * その場合はブログ固有の項目が `null`／空になるだけ。
 */
export function resolveEffectivePersona(
  persona: AppUserPersona,
  setting: AppBlogPersonaSetting | null,
): EffectivePersona {
  if (setting === null) {
    return {
      baseProfile: persona.baseProfile,
      tone: persona.tone,
      values: persona.values,
      ngExpressions: persona.ngExpressions,
      penName: null,
      targetReader: null,
      writingRules: null,
      ngTopics: [],
    };
  }

  return {
    baseProfile: persona.baseProfile,
    // **ここが上書きの本体。** 未指定の項目は共通人格のまま
    tone: { ...persona.tone, ...setting.toneOverride },
    values: persona.values,
    ngExpressions: persona.ngExpressions,
    penName: setting.penName,
    targetReader: setting.targetReader,
    writingRules: setting.writingRules,
    ngTopics: setting.ngTopics,
  };
}
