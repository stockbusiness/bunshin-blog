/**
 * personas モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `user_personas` `blog_persona_settings` `persona_facts` を触ってよいのは
 * このモジュールだけ。本タスク（D-4）で実装したのは `user_personas` のみ。
 *
 * **IDだけで引く関数を公開しない**（SPEC 14.1）。取得も更新も `userId` を伴う。
 */

export {
  findBlogPersonaSettingForUser,
  saveBlogPersonaSettingForUser,
  updateBlogPersonaSettingForUser,
  resolveEffectivePersonaForUser,
  listPersonaFactsForUser,
  findPersonaFactForUser,
  requirePersonaFactForUser,
  createPersonaFactForUser,
  updatePersonaFactForUser,
  deletePersonaFactForUser,
} from './repository';

export {
  canUseFirstPerson,
  isFirstPersonBlocked,
  normalizeCreatePersonaFact,
  normalizeUpdatePersonaFact,
  isFactType,
  isFactSource,
  isFactVerification,
  FACT_CONTENT_MAX_LENGTH,
  type NormalizedPersonaFact,
} from './facts';

export {
  resolveEffectivePersona,
  normalizeSaveBlogPersonaSetting,
  normalizeUpdateBlogPersonaSetting,
  normalizeToneOverride,
  normalizeWritingRules,
  isKnowledgeLevel,
  isBulletFrequency,
  PEN_NAME_MAX_LENGTH,
  HEADING_DEPTH_MIN,
  HEADING_DEPTH_MAX,
  LEAD_LENGTH_MIN,
  LEAD_LENGTH_MAX,
  type NormalizedBlogPersonaSetting,
} from './blog-settings';

export {
  normalizeTone,
  normalizeValues,
  isEmojiLevel,
  isLineBreakStyle,
  PERSONA_TEXT_MAX_LENGTH,
  PERSONA_LIST_MAX,
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
  KNOWLEDGE_LEVELS,
  BULLET_FREQUENCIES,
  FACT_TYPES,
  FACT_SOURCES,
  FACT_VERIFICATIONS,
  type AppPersonaFact,
  type FactType,
  type FactSource,
  type FactVerification,
  type CreatePersonaFactInput,
  type UpdatePersonaFactInput,
  type AppBlogPersonaSetting,
  type WritingRules,
  type ToneOverride,
  type KnowledgeLevel,
  type BulletFrequency,
  type SaveBlogPersonaSettingInput,
  type UpdateBlogPersonaSettingInput,
  type Tone,
  type PersonaValues,
  type EmojiLevel,
  type LineBreakStyle,
} from './types';

export {
  createPersonaForUser,
  listPersonasForUser,
  findPersonaForUser,
  requirePersonaForUser,
  updatePersonaForUser,
  activatePersonaForUser,
  pausePersonaForUser,
  countActivePersonasForUser,
  getPersonaLimitsForUser,
  type PersonaLimits,
} from './persona-repository';

export {
  normalizeCreatePersona,
  normalizeUpdatePersona,
  normalizeIdentity,
  normalizeExpertise,
  normalizeAudience,
  normalizeBusiness,
  maxActivePersonas,
  PERSONA_TYPES,
  PERSONA_STATUSES,
  MAX_ACTIVE_PERSONAS,
  PERSONA_NAME_MAX_LENGTH,
  type AppPersona,
  type EffectivePersona,
  type CreatePersonaInput,
  type UpdatePersonaInput,
  type PersonaIdentity,
  type PersonaExpertise,
  type PersonaAudience,
  type PersonaBusiness,
  type PersonaType,
  type PersonaStatus,
} from './persona';

export {
  draftPersonaFromAnswers,
  type DraftPersonaDeps,
  type PersonaAnswers,
  type PersonaDraft,
} from './draft';
