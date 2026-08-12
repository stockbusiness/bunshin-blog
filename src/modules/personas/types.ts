/**
 * personas モジュールが外部へ渡す表現（TASKS D-4、SPEC 5.6・DATA_MODEL 3章）。
 *
 * **ユーザー共通人格（`user_personas`）とブログ別設定
 * （`blog_persona_settings`）を分離する**（SPEC 5.6）。本ファイルは前者。
 * ブログ別設定は D-5。
 */

/** 絵文字の量（DATA_MODEL 3章） */
export type EmojiLevel = 'none' | 'low' | 'mid';

/** 改行の入れ方 */
export type LineBreakStyle = 'short' | 'normal';

export const EMOJI_LEVELS: readonly EmojiLevel[] = ['none', 'low', 'mid'];
export const LINE_BREAK_STYLES: readonly LineBreakStyle[] = ['short', 'normal'];

export interface BaseProfile {
  ageRange: string;
  position: string;
  /**
   * 一人称（「私」「僕」など）。
   *
   * **記事の文体を決める中心。** SPEC 5.7 の「一人称体験として使えるか」の
   * 判定とも噛み合う。
   */
  firstPerson: string;
  background: string;
}

export interface Tone {
  style: string;
  emojiLevel: EmojiLevel;
  lineBreak: LineBreakStyle;
  politeness: string;
}

export interface PersonaValues {
  /** 大事にすること */
  priorities: string[];
  /** 避けること */
  avoid: string[];
}

export interface AppUserPersona {
  id: string;
  userId: string;
  baseProfile: BaseProfile;
  tone: Tone;
  values: PersonaValues;
  /** 使わない表現 */
  ngExpressions: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** 新規作成の入力。**4項目すべてが要る** */
export interface CreateUserPersonaInput {
  baseProfile: BaseProfile;
  tone: Tone;
  values: PersonaValues;
  ngExpressions?: string[] | undefined;
}

/**
 * 編集の入力。
 *
 * **項目ごとに丸ごと差し替える。** `tone` を渡したら `tone` の4項目すべてを
 * 指定する。入れ子の一部だけを更新できるようにすると、「今どういう設定に
 * なっているか」が読み手にも書き手にも分からなくなる。
 * ブログ別の部分上書きは D-5 の `tone_override` が担う。
 */
export interface UpdateUserPersonaInput {
  baseProfile?: BaseProfile | undefined;
  tone?: Tone | undefined;
  values?: PersonaValues | undefined;
  ngExpressions?: string[] | undefined;
}

/** 読者の知識レベル（DATA_MODEL 3章） */
export type KnowledgeLevel = 'beginner' | 'intermediate' | 'advanced';

/** 箇条書きの頻度 */
export type BulletFrequency = 'low' | 'mid' | 'high';

export const KNOWLEDGE_LEVELS: readonly KnowledgeLevel[] = [
  'beginner',
  'intermediate',
  'advanced',
];

export const BULLET_FREQUENCIES: readonly BulletFrequency[] = [
  'low',
  'mid',
  'high',
];

export interface WritingRules {
  headingDepth: number;
  leadLength: number;
  bulletFrequency: BulletFrequency;
}

/**
 * 文体の上書き（DATA_MODEL 3章 `tone_override = Partial<typeof tone>`）。
 *
 * **未指定の項目は `user_personas` を継承する。** ここが D-5 の要。
 */
export type ToneOverride = Partial<Tone>;

/**
 * ブログ別の人格設定（`blog_persona_settings`・SPEC 5.6）。
 *
 * **媒体別の上書きだけを持つ**（A-2-R-2d）。読者像は分身が持つもので、
 * ここには無い（`Persona.audience`）。**同じことを2か所に置くと、
 * どちらが正か分からなくなる。**
 */
export interface AppBlogPersonaSetting {
  id: string;
  blogId: string;
  /** 記事の署名に使う名前 */
  penName: string;
  toneOverride: ToneOverride;
  /**
   * 使ってよい体験（`persona_facts` のID）。
   *
   * **A-2-R-2e で外す。** 記憶は分身に溜まり、その分身の媒体は1つなので、
   * 媒体ごとに選び直す意味が無くなった。列の削除は A-2-R-3。
   */
  allowedExperiences: string[];
  /** 触れない話題 */
  ngTopics: string[];
  writingRules: WritingRules;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveBlogPersonaSettingInput {
  penName: string;
  toneOverride?: ToneOverride | undefined;
  ngTopics?: string[] | undefined;
  writingRules: WritingRules;
}

export interface UpdateBlogPersonaSettingInput {
  penName?: string | undefined;
  toneOverride?: ToneOverride | undefined;
  ngTopics?: string[] | undefined;
  writingRules?: WritingRules | undefined;
}

/** 事実の種類（SPEC 5.7） */
export type FactType =
  'EXPERIENCE' | 'OPINION' | 'PROFILE' | 'FAILURE' | 'PRODUCT_REVIEW';

/** 事実の出どころ */
export type FactSource =
  'USER_INPUT' | 'ADMIN_INTERVIEW' | 'EXISTING_CONTENT' | 'AI_INFERENCE';

/** 裏取りの状態 */
export type FactVerification = 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';

export const FACT_TYPES: readonly FactType[] = [
  'EXPERIENCE',
  'OPINION',
  'PROFILE',
  'FAILURE',
  'PRODUCT_REVIEW',
];

export const FACT_SOURCES: readonly FactSource[] = [
  'USER_INPUT',
  'ADMIN_INTERVIEW',
  'EXISTING_CONTENT',
  'AI_INFERENCE',
];

export const FACT_VERIFICATIONS: readonly FactVerification[] = [
  'VERIFIED',
  'UNVERIFIED',
  'REJECTED',
];

/** 本人の経験や意見（`persona_facts`・SPEC 5.7） */
export interface AppPersonaFact {
  id: string;
  userId: string;
  /** ブログ固有の事実なら設定。`null` は全ブログ共通 */
  blogId: string | null;
  factType: FactType;
  content: string;
  source: FactSource;
  verification: FactVerification;
  /**
   * 一人称体験として記事に使ってよいか。
   *
   * **`AI_INFERENCE` かつ `UNVERIFIED` では必ず `false`**（SPEC 5.7）。
   * 書き込みのたびに `canUseFirstPerson` を通すので、この組み合わせで
   * `true` になることはない。
   */
  usableFirstPerson: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePersonaFactInput {
  factType: FactType;
  content: string;
  source: FactSource;
  blogId?: string | undefined;
  verification?: FactVerification | undefined;
  usableFirstPerson?: boolean | undefined;
}

export interface UpdatePersonaFactInput {
  factType?: FactType | undefined;
  content?: string | undefined;
  source?: FactSource | undefined;
  verification?: FactVerification | undefined;
  usableFirstPerson?: boolean | undefined;
}
