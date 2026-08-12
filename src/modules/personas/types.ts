/**
 * personas モジュールが外部へ渡す表現（TASKS D-5、SPEC 5.6・DATA_MODEL 3章）。
 *
 * ここにあるのは**ブログ別設定（`blog_persona_settings`）と、
 * 分身と共有する小さな型**。分身そのものの型は `persona.ts`。
 *
 * 旧 `user_personas` の型は A-2-R-2f で消した。
 */

/** 絵文字の量（DATA_MODEL 3章） */
export type EmojiLevel = 'none' | 'low' | 'mid';

/** 改行の入れ方 */
export type LineBreakStyle = 'short' | 'normal';

export const EMOJI_LEVELS: readonly EmojiLevel[] = ['none', 'low', 'mid'];
export const LINE_BREAK_STYLES: readonly LineBreakStyle[] = ['short', 'normal'];

export interface PersonaValues {
  /** 大事にすること */
  priorities: string[];
  /** 避けること */
  avoid: string[];
}

export interface Tone {
  style: string;
  emojiLevel: EmojiLevel;
  lineBreak: LineBreakStyle;
  politeness: string;
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
