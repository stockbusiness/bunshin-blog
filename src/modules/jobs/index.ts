/**
 * jobs モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `jobs` テーブルを触ってよいのはこのモジュールだけ。
 *
 * **このモジュールはドメインモジュールを import しない**（MODULE_RULES 3）。
 * `jobs → wordpress → jobs` の循環を避けるため、ハンドラの登録は
 * `src/app/` 側で行う。
 *
 * **キューはPostgreSQL。** 外部のキューサービスを使わない（E-1）。
 */

export {
  enqueueJob,
  enqueueJobInTx,
  claimNextJob,
  completeJob,
  failJob,
  reclaimStuckJobs,
  findJobById,
  findJobByIdempotencyKey,
  saveJobCheckpoint,
} from './repository';

export {
  buildIdempotencyKey,
  assertIdempotencyKey,
  matchesJobType,
  IDEMPOTENCY_KEY_SEPARATOR,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from './idempotency';

export {
  performOnce,
  readCheckpoint,
  sideEffectUncertainError,
  CHECKPOINT_FIELD,
  type JobCheckpoint,
  type PerformOnceOptions,
  type SaveCheckpoint,
} from './checkpoint';

export {
  drainJobs,
  DEFAULT_JOB_TIMEOUT_MS,
  DEADLINE_MARGIN_MS,
  type DrainJobsOptions,
  type DrainResult,
  type JobRunnerDeps,
} from './runner';

export {
  backoffSeconds,
  nextAttemptAt,
  isExhausted,
  MAX_ATTEMPTS,
  BASE_BACKOFF_SECONDS,
  MAX_BACKOFF_SECONDS,
  LEASE_SECONDS,
} from './backoff';

export {
  JOB_ERROR_CODES,
  unknownJobTypeError,
  runnerUnauthorizedError,
  type JobErrorCode,
} from './errors';

export {
  JOB_TYPES,
  isJobType,
  type JobType,
  type JobStatus,
  type AppJob,
  type EnqueueJobInput,
  type EnqueueResult,
  type JobHandler,
  type JobHandlerRegistry,
} from './types';
