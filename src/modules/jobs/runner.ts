/**
 * ジョブの実行ループ（TASKS E-1、SPEC 4.3）。
 *
 * **サーバーレス（Vercel）で動かす前提。** 常駐ワーカーを持てないため、
 * 次の2点が設計の中心になる。
 *
 * - **締め切りを持って抜ける。** 関数の実行時間には上限があり、超えると
 *   途中で殺される。残ったジョブは次の起動に任せる
 * - **1件あたりの時間も区切る。** 1件が長引くと、そのジョブごと関数が
 *   殺され、行が `RUNNING` のまま残る（回収は `reclaimStuckJobs`）
 *
 * **ドメインモジュールを import しない**（MODULE_RULES 3）。
 * ハンドラは `src/app/` 側から渡す。
 */

import { logger, type Logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { JOB_ERROR_CODES } from './errors';
import type { AppJob, JobHandlerRegistry, JobType } from './types';

/** 1件のジョブに許す時間。超えたら失敗として記録し、次のジョブへ進む */
export const DEFAULT_JOB_TIMEOUT_MS = 45_000;

/**
 * 締め切りの手前で止める余裕。
 *
 * 応答を返す時間を残しておかないと、関数ごと殺されて実行結果が
 * 記録されない。
 */
export const DEADLINE_MARGIN_MS = 3_000;

export interface DrainJobsOptions {
  registry: JobHandlerRegistry;
  /** この時刻までに抜ける */
  deadline: Date;
  jobTimeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
  /** 差し替え用。既定は `repository.ts` */
  deps?: JobRunnerDeps;
}

export interface JobRunnerDeps {
  reclaimStuckJobs(): Promise<number>;
  claimNextJob(jobTypes: readonly string[]): Promise<AppJob | null>;
  completeJob(jobId: string, output: unknown): Promise<AppJob>;
  failJob(
    jobId: string,
    failure: { code: string; message: string },
  ): Promise<AppJob>;
}

export interface DrainResult {
  /** `RUNNING` から戻した件数 */
  reclaimed: number;
  succeeded: number;
  failed: number;
  /** 締め切りに達して残したか */
  stoppedByDeadline: boolean;
}

/** ハンドラの失敗を、保存できる形へ落とす */
function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: String(error.code), message: error.message };
  }

  if (error instanceof Error) {
    return { code: JOB_ERROR_CODES.handlerFailed, message: error.message };
  }

  return { code: JOB_ERROR_CODES.handlerFailed, message: '不明なエラー' };
}

/**
 * ハンドラを時間制限つきで走らせる。
 *
 * **競争させるだけで、ハンドラ自体は止まらない。** 止める手段は
 * ハンドラ側にしかない（`safeFetch` のタイムアウトなど）。ここでの
 * 目的は「1件に引きずられてワーカー全体が殺される」のを避けること。
 */
async function runWithTimeout(
  run: Promise<unknown>,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError(
          JOB_ERROR_CODES.jobTimeout,
          504,
          `ジョブが${timeoutMs}ms以内に終わりませんでした`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * キューを消化する。
 *
 * 1. `RUNNING` のまま放置された行を戻す
 * 2. 締め切りまで、登録済みの種類のジョブを1件ずつ取って実行する
 * 3. 取れなくなるか、締め切りに達したら抜ける
 */
export async function drainJobs(
  options: DrainJobsOptions,
): Promise<DrainResult> {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? logger;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const deps = options.deps ?? (await defaultDeps());

  const jobTypes = Object.keys(options.registry) as JobType[];

  const result: DrainResult = {
    reclaimed: await deps.reclaimStuckJobs(),
    succeeded: 0,
    failed: 0,
    stoppedByDeadline: false,
  };

  if (result.reclaimed > 0) {
    log.warn('中断されたジョブを戻した', { count: result.reclaimed });
  }

  if (jobTypes.length === 0) {
    return result;
  }

  for (;;) {
    const remaining = options.deadline.getTime() - now().getTime();
    if (remaining <= DEADLINE_MARGIN_MS) {
      result.stoppedByDeadline = true;
      break;
    }

    const job = await deps.claimNextJob(jobTypes);
    if (job === null) {
      break;
    }

    const handler = options.registry[job.jobType as JobType];
    if (handler === undefined) {
      // 取得条件で絞っているため通常は起きない。取りこぼしても
      // `RUNNING` のまま残さない
      await deps.failJob(job.id, {
        code: JOB_ERROR_CODES.noHandler,
        message: `ハンドラが登録されていません: ${job.jobType}`,
      });
      result.failed += 1;
      continue;
    }

    // 締め切りまでの残りと、1件あたりの上限の短いほうを使う
    const budget = Math.min(jobTimeoutMs, remaining - DEADLINE_MARGIN_MS);

    try {
      const output = await runWithTimeout(handler(job), budget);
      await deps.completeJob(job.id, output ?? null);
      result.succeeded += 1;
      log.info('ジョブが完了した', {
        jobId: job.id,
        jobType: job.jobType,
        attempt: job.attemptCount,
      });
    } catch (error) {
      const failure = describeFailure(error);
      const updated = await deps.failJob(job.id, failure);
      result.failed += 1;
      log.warn('ジョブが失敗した', {
        jobId: job.id,
        jobType: job.jobType,
        attempt: job.attemptCount,
        code: failure.code,
        // 上限に達したかどうかは運用の判断に要る
        exhausted: updated.status === 'FAILED',
        cause: error,
      });
    }
  }

  return result;
}

/** 既定の差し込み。テストからは `deps` を渡して差し替える */
async function defaultDeps(): Promise<JobRunnerDeps> {
  const repository = await import('./repository');

  return {
    reclaimStuckJobs: repository.reclaimStuckJobs,
    claimNextJob: repository.claimNextJob,
    completeJob: repository.completeJob,
    failJob: repository.failJob,
  };
}
