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
  /** 冪等性キーの形が不正（C-4） */
  invalidIdempotencyKey: 'JOB_INVALID_IDEMPOTENCY_KEY',
  /** 前回の実行が外部呼び出しの最中に中断した（C-4） */
  sideEffectUncertain: 'JOB_SIDE_EFFECT_UNCERTAIN',
  /** ワーカーの起動が認可されていない */
  runnerUnauthorized: 'JOB_RUNNER_UNAUTHORIZED',
  /** ワーカーの起動に必要な設定が無い */
  runnerNotConfigured: 'JOB_RUNNER_NOT_CONFIGURED',
  /** 積み直そうとしたジョブが無い（H-14） */
  notFound: 'JOB_NOT_FOUND',
  /** `FAILED` でないジョブを積み直そうとした（H-14） */
  notRetryable: 'JOB_NOT_RETRYABLE',
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

/** 積み直そうとしたジョブが無い（H-14） */
export function jobNotFoundError(): AppError {
  return new AppError(JOB_ERROR_CODES.notFound, 404, 'ジョブが見つかりません');
}

/**
 * `FAILED` でないジョブは積み直せない（H-14）。
 *
 * **いまの状態を返す。** ADMIN しか触れない入口で、
 * 「なぜ押せないのか」が分からないと運用で止まる
 */
export function jobNotRetryableError(status: string): AppError {
  return new AppError(
    JOB_ERROR_CODES.notRetryable,
    409,
    `失敗したジョブだけを積み直せます（いまの状態: ${status}）`,
  );
}
