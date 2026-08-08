import { AppError } from '@/lib/errors';

/** ジョブ基盤のエラーコード（TASKS E-1） */
export const JOB_ERROR_CODES = {
  /** 知らない種類のジョブ */
  unknownType: 'JOB_UNKNOWN_TYPE',
  /** ハンドラが登録されていない */
  noHandler: 'JOB_NO_HANDLER',
  /** ジョブの処理が例外で終わった */
  handlerFailed: 'JOB_HANDLER_FAILED',
  /** 1件あたりの実行時間を超えた */
  jobTimeout: 'JOB_TIMEOUT',
  /** ワーカーの起動が認可されていない */
  runnerUnauthorized: 'JOB_RUNNER_UNAUTHORIZED',
  /** ワーカーの起動に必要な設定が無い */
  runnerNotConfigured: 'JOB_RUNNER_NOT_CONFIGURED',
} as const;

export type JobErrorCode =
  (typeof JOB_ERROR_CODES)[keyof typeof JOB_ERROR_CODES];

export function unknownJobTypeError(jobType: string): AppError {
  return new AppError(
    JOB_ERROR_CODES.unknownType,
    422,
    `扱えない種類のジョブです: ${jobType}`,
  );
}

/**
 * ワーカーの起動が認可されていないことを表す。
 *
 * **理由を返さない。** 「秘密が違う」と「秘密が未設定」を区別すると、
 * 外から設定状態を調べられる。
 */
export function runnerUnauthorizedError(): AppError {
  return new AppError(
    JOB_ERROR_CODES.runnerUnauthorized,
    401,
    '認可されていません',
  );
}
