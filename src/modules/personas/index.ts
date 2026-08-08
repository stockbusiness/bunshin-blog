/**
 * personas モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `user_personas` `blog_persona_settings` `persona_facts` を触ってよいのは
 * このモジュールだけ。本タスク（D-4）で実装したのは `user_personas` のみ。
 *
 * **IDだけで引く関数を公開しない**（SPEC 14.1）。取得も更新も `userId` を伴う。
 */

export {
  findUserPersonaForUser,
  requireUserPersonaForUser,
  saveUserPersonaForUser,
  updateUserPersonaForUser,
} from './repository';

export {
  normalizeCreateUserPersona,
  normalizeUpdateUserPersona,
  normalizeBaseProfile,
  normalizeTone,
  normalizeValues,
  isEmojiLevel,
  isLineBreakStyle,
  PERSONA_TEXT_MAX_LENGTH,
  PERSONA_BACKGROUND_MAX_LENGTH,
  FIRST_PERSON_MAX_LENGTH,
  PERSONA_LIST_MAX,
  type NormalizedUserPersona,
} from './validate';

export {
  PERSONA_ERROR_CODES,
  invalidPersonaError,
  personaNotFoundError,
  type PersonaErrorCode,
} from './errors';

export {
  EMOJI_LEVELS,
  LINE_BREAK_STYLES,
  type AppUserPersona,
  type BaseProfile,
  type Tone,
  type PersonaValues,
  type EmojiLevel,
  type LineBreakStyle,
  type CreateUserPersonaInput,
  type UpdateUserPersonaInput,
} from './types';
