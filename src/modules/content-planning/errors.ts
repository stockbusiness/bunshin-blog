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
  /** STEP 3 の入力または受け取った記事が組み立てられない */
  invalidStep3Input: 'PLANNING_INVALID_STEP3_INPUT',
  /** STEP 4 のリンク設計が成り立たない */
  invalidStep4Input: 'PLANNING_INVALID_STEP4_INPUT',
  /** 指定した構成表が無い（他人のものも同じ扱い） */
  planNotFound: 'PLANNING_PLAN_NOT_FOUND',
  /** 再生成を繰り返しても制約を満たせなかった */
  notConverged: 'PLANNING_NOT_CONVERGED',
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

/**
 * 収益記事を組み立てられないことを表す。
 *
 * **枠との一致を確かめずに保存しない。** 確かめないと、AIが枠を増やしたり
 * 減らしたりした構成表がそのまま通る。
 */
export function invalidStep3InputError(reason: string): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.invalidStep3Input,
    422,
    `収益記事の設計を確認してください：${reason}`,
  );
}

/**
 * リンク設計が成り立たないことを表す。
 *
 * **リンク先が `AFFILIATE` 以外だったときにも使う**（E-7 の完了条件）。
 * 手作業での検証では30本中9本でこの誤りが起きた（CONTENT_PLANNING 5.5）。
 */
export function invalidStep4InputError(reason: string): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.invalidStep4Input,
    422,
    `集客記事とリンクの設計を確認してください：${reason}`,
  );
}

/**
 * 構成表が見つからないことを表す。
 *
 * **他人の構成表も「無い」として返す**（SPEC 14.1）。区別すると、
 * IDの総当たりで他人の構成表の有無を調べられる。
 */
export function planNotFoundError(): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.planNotFound,
    404,
    '構成表が見つかりません',
  );
}

/**
 * 3回やり直しても制約を満たせなかったことを表す。
 *
 * **暫定的な構成表を返さない**（SPEC 9.2.6）。「だいたい通った」ものを
 * 承認依頼へ送ると、制約チェックの意味が無くなる。ジョブを `FAILED` にし、
 * ADMINへ通知する。
 */
export function planningNotConvergedError(codes: readonly string[]): AppError {
  return new AppError(
    PLANNING_ERROR_CODES.notConverged,
    500,
    `構成表が制約を満たしませんでした（${codes.join('、')}）`,
  );
}
