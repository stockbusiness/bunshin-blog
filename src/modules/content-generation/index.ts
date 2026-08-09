/**
 * content-generation モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `article_versions` `prompt_versions` を触ってよいのはこのモジュールだけ。
 * 本タスク（E-2）で実装したのは `prompt_versions` のみ。
 *
 * **プロンプトは利用者に紐づかない。** システム全体で1組で、触れるのは
 * ADMIN だけ（SPEC 6.2）。`...ForAdmin` の名前で横断参照であることを示す。
 */

export {
  findActivePrompt,
  requireActivePrompt,
  listPromptVersionsForAdmin,
  findPromptVersionForAdmin,
  createPromptVersionForAdmin,
  activatePromptVersionForAdmin,
  deactivatePromptForAdmin,
} from './repository';

export {
  generateArticleForUser,
  type GenerateArticleForUserInput,
  type GenerateArticleDeps,
} from './generate';

export {
  requirePlannedItemForUser,
  listArticleVersionsForUser,
  listSiblingItemsForUser,
  saveArticleVersion,
  type AppArticleVersion,
  type SaveArticleVersionInput,
} from './article-repository';

export {
  extractHrefs,
  assertAllowedLinks,
  assertPrDisclosure,
  assertUsedFacts,
  articleContentHash,
  PR_DISCLOSURE_PATTERNS,
} from './article';

export {
  generateArticle,
  operationForContentType,
  GENERATION_PROMPT_KEYS,
  type GeneratedArticle,
  type ArticleGenerationInput,
  type GenerateArticleResult,
} from './ai';

export {
  normalizeCreatePromptVersion,
  normalizePromptKey,
  normalizePromptVersion,
  PROMPT_KEY_MAX_LENGTH,
  PROMPT_VERSION_MAX_LENGTH,
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_NOTES_MAX_LENGTH,
  type NormalizedPromptVersion,
} from './prompt';

export {
  PROMPT_ERROR_CODES,
  invalidPromptError,
  duplicateVersionError,
  promptNotFoundError,
  noActiveVersionError,
  invalidArticleError,
  itemNotInPlanError,
  type PromptErrorCode,
} from './errors';

export type { AppPromptVersion, CreatePromptVersionInput } from './types';
