import { AppError } from '@/lib/errors';

/** content-planning モジュールのエラーコード（TASKS E-4） */
export const PLANNING_ERROR_CODES = {
  /** STEP 1 の入力が判定できる形になっていない */
  invalidStep1Input: 'PLANNING_INVALID_STEP1_INPUT',
  /** 指定したジャンルが `genres` に無い */
  genreNotFound: 'PLANNING_GENRE_NOT_FOUND',
  /** 停止条件に該当したまま続行しようとした */
  overrideNotAllowed: 'PLANNING_OVERRIDE_NOT_ALLOWED',
  /** AIの応答が想定の形でない */
  invalidAiResponse: 'PLANNING_INVALID_AI_RESPONSE',
} as const;

export type PlanningErrorCode =
  (typeof PLANNING_ERROR_CODES)[keyof typeof PLANNING_ERROR_CODES];

/**
 * 判定できる入力になっていないことを表す。
 *
 * **判定を飛ばして通さない。** 検索上位が取れないときに「該当なし」として
 * 通すと、大手が占めるジャンルが検索APIの不調のたびに通る。
 */
export function invalidStep1InputError(reason: string): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.invalidStep1Input,
    422,
    `ジャンル審査の入力を確認してください：${reason}`,
  );
}

export function genreNotFoundError(): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.genreNotFound,
    404,
    'ジャンルが見つかりません',
  );
}

/**
 * まだ続行を選べないことを表す。
 *
 * **差し戻し2回より前に「承知で進める」を通さない**（SPEC 9.2.2）。
 * 通すと、停止条件が実質的に無くなる。
 */
export function overrideNotAllowedError(remaining: number): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.overrideNotAllowed,
    409,
    `別のジャンルをあと${remaining}回まで試せます。続行を選べるのはその後です`,
  );
}

/**
 * AIの応答が読めなかったことを表す。
 *
 * **応答本文をメッセージへ入れない。** 何が返るか分からないものを
 * そのまま外へ出さない。
 */
export function invalidAiResponseError(key: string): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.invalidAiResponse,
    502,
    `AIの応答を読めませんでした（${key}）`,
  );
}
