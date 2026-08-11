/**
 * 分身の型と検証（TASKS A-2-R-2、ROADMAP 2章、DATA_MODEL 3章）。
 *
 * **1ユーザーが複数の分身を持つ。** `user_personas`（1ユーザー1件）を
 * 置き換えるもので、事業計画の「分身が主、媒体が従」に合わせる。
 *
 * ## 4つの jsonb
 *
 * `identity` `expertise` `audience` `business` は**DBが中身を保証しない**。
 * 保存の直前にここで形を固定する。壊れた形のまま入ると、記事生成（E-8）が
 * 読めない値を掴んで落ちる（`validate.ts` と同じ理由）。
 *
 * ## 旧モデルと並存する
 *
 * `user_personas` は A-2-R-3 まで残る（Q-033）。**新しく書くコードは
 * こちらを使う。**
 */

import { invalidPersonaError } from './errors';
import {
  EMOJI_LEVELS,
  KNOWLEDGE_LEVELS,
  LINE_BREAK_STYLES,
  type EmojiLevel,
  type KnowledgeLevel,
  type LineBreakStyle,
  type Tone,
} from './types';

/** 分身の種類（ROADMAP 2章） */
export const PERSONA_TYPES = ['SELF', 'IDEAL', 'CHARACTER'] as const;
export type PersonaType = (typeof PERSONA_TYPES)[number];

/** 分身の状態。`ACTIVE` の数が段階解放の対象になる */
export const PERSONA_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

/**
 * 同時に `ACTIVE` にできる分身の数（DATA_MODEL 3章、ROADMAP 5章）。
 *
 * **3件が上限。** SPEC 1.2 の「1ユーザー3ブログ」を人格で言い換えたもの。
 */
export const MAX_ACTIVE_PERSONAS = 3;

export const PERSONA_NAME_MAX_LENGTH = 50;
export const PERSONA_TEXT_MAX_LENGTH = 200;
export const PERSONA_LONG_TEXT_MAX_LENGTH = 1000;
export const PERSONA_LIST_MAX = 20;

/** 名前・性格・価値観・文体・禁止表現 */
export interface PersonaIdentity {
  name: string;
  /** 一人称。**記事の文体を決める中心**（SPEC 5.7 の一人称判定と噛み合う） */
  firstPerson: string;
  background: string;
  tone: Tone;
  values: { priorities: string[]; avoid: string[] };
  /** 使わない表現 */
  ngExpressions: string[];
}

/** 専門領域・情報源・評価基準 */
export interface PersonaExpertise {
  fields: string[];
  sources: string[];
  evaluationCriteria: string[];
}

/** 読者像・悩み・検索意図 */
export interface PersonaAudience {
  ageRange: string;
  situation: string;
  knowledgeLevel: KnowledgeLevel;
  problems: string[];
  searchIntents: string[];
}

/** 収益方針・目標・KPI・撤退条件 */
export interface PersonaBusiness {
  revenuePolicy: string;
  monthlyGoalYen: number;
  kpis: string[];
  /**
   * 撤退条件。
   *
   * **先に決めさせる。** 続けるかどうかを後から決めると、
   * 沈んだ費用に引きずられる（SPEC 1.2 の実験としての性格）。
   */
  exitCriteria: string;
}

export interface AppPersona {
  id: string;
  userId: string;
  name: string;
  personaType: PersonaType;
  identity: PersonaIdentity;
  expertise: PersonaExpertise;
  audience: PersonaAudience;
  business: PersonaBusiness;
  status: PersonaStatus;
  /** 段階解放の起点（ROADMAP 5章）。`ACTIVE` になった時刻 */
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePersonaInput {
  name: string;
  personaType: PersonaType;
  identity: PersonaIdentity;
  expertise: PersonaExpertise;
  audience: PersonaAudience;
  business: PersonaBusiness;
}

/** 更新は部分適用。**渡さなかった項目は変えない** */
export type UpdatePersonaInput = Partial<CreatePersonaInput>;

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
 * **重複を落とす。** 同じ語が2つ入っていても意味が無く、プロンプトが
 * 無駄に長くなる（AI費用に効く）。`validate.ts` と同じ方針。
 */
function assertTextList(
  value: unknown,
  label: string,
  options: { required?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw invalidPersonaError(`${label}を配列で入力してください`);
  }

  if (value.length > PERSONA_LIST_MAX) {
    throw invalidPersonaError(
      `${label}は${PERSONA_LIST_MAX}件以内で入力してください`,
    );
  }

  const items = value.map((item) =>
    assertText(item, label, PERSONA_TEXT_MAX_LENGTH),
  );

  if (options.required === true && items.length === 0) {
    throw invalidPersonaError(`${label}を1件以上入力してください`);
  }

  return [...new Set(items)];
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw invalidPersonaError(`${label}が不正です`);
  }

  return value as T;
}

function normalizeTone(value: unknown): Tone {
  if (typeof value !== 'object' || value === null) {
    throw invalidPersonaError('文体を入力してください');
  }

  const record = value as Record<string, unknown>;

  return {
    style: assertText(record['style'], '文体', PERSONA_TEXT_MAX_LENGTH),
    emojiLevel: assertEnum<EmojiLevel>(
      record['emojiLevel'],
      EMOJI_LEVELS,
      '絵文字の量',
    ),
    lineBreak: assertEnum<LineBreakStyle>(
      record['lineBreak'],
      LINE_BREAK_STYLES,
      '改行',
    ),
    politeness: assertText(
      record['politeness'],
      '丁寧さ',
      PERSONA_TEXT_MAX_LENGTH,
    ),
  };
}

export function normalizeIdentity(value: unknown): PersonaIdentity {
  if (typeof value !== 'object' || value === null) {
    throw invalidPersonaError('人物像を入力してください');
  }

  const record = value as Record<string, unknown>;
  const values = record['values'];

  if (typeof values !== 'object' || values === null) {
    throw invalidPersonaError('価値観を入力してください');
  }

  const valuesRecord = values as Record<string, unknown>;

  return {
    name: assertText(record['name'], '名前', PERSONA_NAME_MAX_LENGTH),
    firstPerson: assertText(record['firstPerson'], '一人称', 10),
    background: assertText(
      record['background'],
      '背景',
      PERSONA_LONG_TEXT_MAX_LENGTH,
    ),
    tone: normalizeTone(record['tone']),
    values: {
      priorities: assertTextList(valuesRecord['priorities'], '大事にすること'),
      avoid: assertTextList(valuesRecord['avoid'], '避けること'),
    },
    ngExpressions: assertTextList(record['ngExpressions'], '使わない表現'),
  };
}

export function normalizeExpertise(value: unknown): PersonaExpertise {
  if (typeof value !== 'object' || value === null) {
    throw invalidPersonaError('専門領域を入力してください');
  }

  const record = value as Record<string, unknown>;

  return {
    // **1件以上を必須にする。** 専門が空の分身は、何を書く人なのかが決まらない
    fields: assertTextList(record['fields'], '専門領域', { required: true }),
    sources: assertTextList(record['sources'], '情報源'),
    evaluationCriteria: assertTextList(
      record['evaluationCriteria'],
      '評価基準',
    ),
  };
}

export function normalizeAudience(value: unknown): PersonaAudience {
  if (typeof value !== 'object' || value === null) {
    throw invalidPersonaError('読者像を入力してください');
  }

  const record = value as Record<string, unknown>;

  return {
    ageRange: assertText(record['ageRange'], '年齢層', PERSONA_TEXT_MAX_LENGTH),
    situation: assertText(
      record['situation'],
      '状況',
      PERSONA_LONG_TEXT_MAX_LENGTH,
    ),
    knowledgeLevel: assertEnum<KnowledgeLevel>(
      record['knowledgeLevel'],
      KNOWLEDGE_LEVELS,
      '知識レベル',
    ),
    problems: assertTextList(record['problems'], '悩み'),
    searchIntents: assertTextList(record['searchIntents'], '検索意図'),
  };
}

export function normalizeBusiness(value: unknown): PersonaBusiness {
  if (typeof value !== 'object' || value === null) {
    throw invalidPersonaError('収益方針を入力してください');
  }

  const record = value as Record<string, unknown>;
  const goal = record['monthlyGoalYen'];

  if (
    typeof goal !== 'number' ||
    !Number.isInteger(goal) ||
    goal < 0 ||
    goal > 100_000_000
  ) {
    throw invalidPersonaError('月間目標額を0以上の整数で入力してください');
  }

  return {
    revenuePolicy: assertText(
      record['revenuePolicy'],
      '収益方針',
      PERSONA_LONG_TEXT_MAX_LENGTH,
    ),
    monthlyGoalYen: goal,
    kpis: assertTextList(record['kpis'], 'KPI'),
    // **撤退条件は必須。** 後から決めると沈んだ費用に引きずられる
    exitCriteria: assertText(
      record['exitCriteria'],
      '撤退条件',
      PERSONA_LONG_TEXT_MAX_LENGTH,
    ),
  };
}

export function normalizeCreatePersona(input: unknown): CreatePersonaInput {
  if (typeof input !== 'object' || input === null) {
    throw invalidPersonaError('入力がありません');
  }

  const record = input as Record<string, unknown>;

  return {
    name: assertText(record['name'], '分身の名前', PERSONA_NAME_MAX_LENGTH),
    personaType: assertEnum<PersonaType>(
      record['personaType'],
      PERSONA_TYPES,
      '分身の種類',
    ),
    identity: normalizeIdentity(record['identity']),
    expertise: normalizeExpertise(record['expertise']),
    audience: normalizeAudience(record['audience']),
    business: normalizeBusiness(record['business']),
  };
}

/**
 * 更新の入力を整える。
 *
 * **渡さなかった項目は触らない。** 部分更新のつもりで送った値が
 * 既定値で上書きされると、気づかないまま設定が消える。
 */
export function normalizeUpdatePersona(input: unknown): UpdatePersonaInput {
  if (typeof input !== 'object' || input === null) {
    throw invalidPersonaError('入力がありません');
  }

  const record = input as Record<string, unknown>;
  const result: UpdatePersonaInput = {};

  if (record['name'] !== undefined) {
    result.name = assertText(
      record['name'],
      '分身の名前',
      PERSONA_NAME_MAX_LENGTH,
    );
  }

  if (record['personaType'] !== undefined) {
    result.personaType = assertEnum<PersonaType>(
      record['personaType'],
      PERSONA_TYPES,
      '分身の種類',
    );
  }

  if (record['identity'] !== undefined) {
    result.identity = normalizeIdentity(record['identity']);
  }

  if (record['expertise'] !== undefined) {
    result.expertise = normalizeExpertise(record['expertise']);
  }

  if (record['audience'] !== undefined) {
    result.audience = normalizeAudience(record['audience']);
  }

  if (record['business'] !== undefined) {
    result.business = normalizeBusiness(record['business']);
  }

  return result;
}

/**
 * 経過日数から、`ACTIVE` にできる分身の数を返す（ROADMAP 5章）。
 *
 * **習熟に合わせて開ける。** 1体目で操作を覚えてから2体目へ進む。
 * 最初から3体を渡すと、承認が溜まって止まる。
 *
 * **起点をどこにするかは未決**（OPEN_QUESTIONS Q-034）。この関数は
 * 経過日数だけを受け取り、起点の判断を持たない。
 */
export function maxActivePersonas(elapsedDays: number): number {
  if (elapsedDays >= 60) {
    return 3;
  }

  if (elapsedDays >= 30) {
    return 2;
  }

  return 1;
}
