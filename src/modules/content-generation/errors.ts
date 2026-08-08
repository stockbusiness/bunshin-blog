import { AppError } from '@/lib/errors';

/** content-generation モジュールのエラーコード（TASKS E-2） */
export const PROMPT_ERROR_CODES = {
  /** 入力の形式が受け付けられない */
  invalidPrompt: 'PROMPT_INVALID',
  /** 同じ `key` に同じ `version` が既にある */
  duplicateVersion: 'PROMPT_DUPLICATE_VERSION',
  /** 指定した版が無い */
  notFound: 'PROMPT_NOT_FOUND',
  /** 有効な版が無い */
  noActiveVersion: 'PROMPT_NO_ACTIVE_VERSION',
} as const;

export type PromptErrorCode =
  (typeof PROMPT_ERROR_CODES)[keyof typeof PROMPT_ERROR_CODES];

export function invalidPromptError(reason: string): AppError {
  return new AppError(
    PROMPT_ERROR_CODES.invalidPrompt,
    422,
    `プロンプトの内容を確認してください：${reason}`,
  );
}

/**
 * 同じ版を作り直そうとしたことを表す。
 *
 * **上書きしない。** 版は「どのプロンプトで生成したか」を後から辿るための
 * 記録で（`article_versions.prompt_version` が参照する）、中身が変わると
 * **過去の記事の生成条件が分からなくなる**。
 */
export function duplicateVersionError(key: string, version: string): AppError {
  return new AppError(
    PROMPT_ERROR_CODES.duplicateVersion,
    409,
    `${key} の ${version} は既にあります。版を上書きせず、新しい版を作ってください`,
  );
}

export function promptNotFoundError(): AppError {
  return new AppError(
    PROMPT_ERROR_CODES.notFound,
    404,
    'プロンプトが見つかりません',
  );
}

/**
 * 有効な版が無いことを表す。
 *
 * **記事生成を止める。** 版が決まらないまま生成すると、何で作った記事か
 * 記録できない。
 */
export function noActiveVersionError(key: string): AppError {
  return new AppError(
    PROMPT_ERROR_CODES.noActiveVersion,
    500,
    `${key} に有効なプロンプトがありません`,
  );
}
