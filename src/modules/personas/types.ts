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
