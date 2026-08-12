import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  BASE_BACKOFF_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_SECONDS,
} from './backoff';
import { CHECKPOINT_FIELD, type JobCheckpoint } from './checkpoint';
import {
  jobNotFoundError,
  jobNotRetryableError,
  unknownJobTypeError,
} from './errors';
import { assertIdempotencyKey } from './idempotency';
import {
  isJobType,
  type AppJob,
  type EnqueueJobInput,
  type EnqueueResult,
  type JobStatus,
} from './types';

/**
 * `jobs` テーブルへのアクセス（TASKS E-1）。
 *
 * **このモジュールだけが `jobs` を触る**（MODULE_RULES 1）。
 *
 * **キューはPostgreSQLそのもの。** 外部のキューサービスを使わない。
 * `jobs.idempotency_key` は unique、`jobs(status, job_type)` の索引は
 * DATA_MODEL 5章が「ワーカーのポーリング」用と定めており、
 * A-2 の時点でDBをキューにする前提で設計されている。
 *
 * **`user_id` で絞らない。** ジョブは利用者の要求ではなくシステムの処理で、
 * ワーカーは全ユーザーのジョブを横断して実行する。`ForAdmin` と同じく
 * 「横断参照であること」が分かる名前と場所に隔離する（MODULE_RULES 5）。
 */

interface JobRow {
  id: string;
  jobType: string;
  userId: string | null;
  blogId: string | null;
  targetId: string | null;
  status: string;
  attemptCount: number;
  idempotencyKey: string;
  inputJson: unknown;
  outputJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  jobType: true,
  userId: true,
  blogId: true,
  targetId: true,
  status: true,
  attemptCount: true,
  idempotencyKey: true,
  inputJson: true,
  outputJson: true,
  errorCode: true,
  errorMessage: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toAppJob(row: JobRow): AppJob {
  return {
    id: row.id,
    jobType: row.jobType,
    userId: row.userId,
    blogId: row.blogId,
    targetId: row.targetId,
    status: row.status as JobStatus,
    attemptCount: row.attemptCount,
    idempotencyKey: row.idempotencyKey,
    input: row.inputJson,
    output: row.outputJson,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 生SQLの戻り値（列名はDBのまま） */
interface RawJobRow {
  id: string;
  job_type: string;
  user_id: string | null;
  blog_id: string | null;
  target_id: string | null;
  status: string;
  attempt_count: number;
  idempotency_key: string;
  input_json: unknown;
  output_json: unknown;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function fromRaw(row: RawJobRow): AppJob {
  return toAppJob({
    id: row.id,
    jobType: row.job_type,
    userId: row.user_id,
    blogId: row.blog_id,
    targetId: row.target_id,
    status: row.status,
    attemptCount: row.attempt_count,
    idempotencyKey: row.idempotency_key,
    inputJson: row.input_json,
    outputJson: row.output_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * ジョブを積む。**同じ `idempotency_key` なら積み直さない。**
 *
 * 「引いてから入れる」を分けると、同時に2回呼ばれたときに両方が通る。
 * unique 制約に任せ、衝突したら既存を返す（B-11 の1文更新と同じ考え）。
 */
export async function enqueueJob(
  input: EnqueueJobInput,
): Promise<EnqueueResult> {
  if (!isJobType(input.jobType)) {
    throw unknownJobTypeError(input.jobType);
  }

  // **積む前にキーの形を確かめる**（C-4）。種類が前置されていないキーは、
  // 別の種類の同じ対象と衝突し、後から積んだほうが黙って捨てられる
  assertIdempotencyKey(input.jobType, input.idempotencyKey);

  try {
    const created = await prisma.job.create({
      data: {
        jobType: input.jobType,
        idempotencyKey: input.idempotencyKey,
        inputJson: input.input as Prisma.InputJsonValue,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.blogId === undefined ? {} : { blogId: input.blogId }),
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      },
      select: SELECT,
    });

    return { job: toAppJob(created), created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.job.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: SELECT,
      });

      if (existing !== null) {
        return { job: toAppJob(existing), created: false };
      }
    }

    throw error;
  }
}

/**
 * `RUNNING` のまま放置された行を `QUEUED` へ戻す。
 *
 * **サーバーレスでは必須。** 関数が実行時間の上限で殺されると、行は
 * `RUNNING` のまま残り、そのジョブは二度と動かない。
 *
 * **`attempt_count` は戻さない。** 取得時に加算済みで、毎回タイムアウトする
 * ジョブが無限に再試行されるのを防ぐ。
 *
 * @returns 戻した件数
 */
export async function reclaimStuckJobs(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    update jobs
       set status = 'QUEUED',
           started_at = null,
           error_code = 'JOB_TIMEOUT',
           error_message = '実行中に中断されたため戻しました',
           updated_at = now()
     where status = 'RUNNING'
       and started_at is not null
       and started_at <= now() - make_interval(secs => ${LEASE_SECONDS}::double precision)
    returning id
  `;

  return rows.length;
}

/**
 * 次に実行するジョブを1件取り、`RUNNING` にする。
 *
 * **`FOR UPDATE SKIP LOCKED` を使う。** 同時に複数のワーカーが動いても、
 * 同じ行を二重に取らない。Vercel の関数は並行して起動しうる。
 *
 * 取得条件は次の3つ。
 *
 * - `QUEUED` である
 * - 登録済みの種類である
 * - **再試行の待ち時間が過ぎている。** 待ち時間は `updated_at` からの
 *   経過で判定する（`backoff.ts` と同じ式。専用の列を持たない）
 *
 * @returns 取れなければ `null`
 */
export async function claimNextJob(
  jobTypes: readonly string[],
): Promise<AppJob | null> {
  if (jobTypes.length === 0) {
    return null;
  }

  const rows = await prisma.$queryRaw<RawJobRow[]>`
    update jobs
       set status = 'RUNNING',
           attempt_count = attempt_count + 1,
           started_at = now(),
           updated_at = now()
     where id = (
       select id from jobs
        where status = 'QUEUED'
          and job_type = any(${jobTypes as string[]}::text[])
          and attempt_count < ${MAX_ATTEMPTS}
          and (
            attempt_count = 0
            or updated_at <= now() - make_interval(secs => least(
                 ${BASE_BACKOFF_SECONDS}::double precision * power(2, attempt_count - 1),
                 ${MAX_BACKOFF_SECONDS}::double precision
               ))
          )
        order by created_at
        for update skip locked
        limit 1
     )
    returning id, job_type, user_id, blog_id, target_id, status, attempt_count,
              idempotency_key, input_json, output_json, error_code, error_message,
              started_at, completed_at, created_at, updated_at
  `;

  const row = rows[0];

  return row === undefined ? null : fromRaw(row);
}

/** 成功として記録する */
export async function completeJob(
  jobId: string,
  output: unknown,
): Promise<AppJob> {
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      outputJson: (output ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
    },
    select: SELECT,
  });

  return toAppJob(updated);
}

/**
 * 失敗として記録する。
 *
 * **上限に達していなければ `QUEUED` へ戻す。** `updated_at` がこの時刻に
 * なるため、次に取れるのは待ち時間の経過後になる。
 */
export async function failJob(
  jobId: string,
  failure: { code: string; message: string },
): Promise<AppJob> {
  const current = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attemptCount: true },
  });

  const exhausted = (current?.attemptCount ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: exhausted ? 'FAILED' : 'QUEUED',
      errorCode: failure.code,
      errorMessage: failure.message,
      startedAt: null,
      ...(exhausted ? { completedAt: new Date() } : {}),
    },
    select: SELECT,
  });

  return toAppJob(updated);
}

/**
 * 外部呼び出しの印を書く（C-4、`checkpoint.ts`）。
 *
 * **`output_json` を使う。** 実行中は空いており、成功すれば `completeJob`
 * が結果で上書きする。専用の列を足さない。
 */
export async function saveJobCheckpoint(
  jobId: string,
  checkpoint: JobCheckpoint | null,
): Promise<void> {
  const value: Prisma.InputJsonObject =
    checkpoint === null
      ? {}
      : {
          [CHECKPOINT_FIELD]: {
            step: checkpoint.step,
            attempt: checkpoint.attempt,
            at: checkpoint.at,
          },
        };

  await prisma.job.update({
    where: { id: jobId },
    data: { outputJson: checkpoint === null ? Prisma.JsonNull : value },
    select: { id: true },
  });
}

/** IDで引く。**ワーカーと管理用途のみ**（利用者向けの入口ではない） */
export async function findJobById(jobId: string): Promise<AppJob | null> {
  const row = await prisma.job.findUnique({
    where: { id: jobId },
    select: SELECT,
  });

  return row === null ? null : toAppJob(row);
}

/** 冪等性キーで引く */
export async function findJobByIdempotencyKey(
  idempotencyKey: string,
): Promise<AppJob | null> {
  const row = await prisma.job.findUnique({
    where: { idempotencyKey },
    select: SELECT,
  });

  return row === null ? null : toAppJob(row);
}

/**
 * トランザクションの中でジョブを積む（F-7）。
 *
 * **承認とジョブは同時に決まる。** 承認したのにジョブが無いと、
 * 記事が永久に投稿されない。逆に、承認が巻き戻ったのにジョブだけ残ると、
 * 承認していない記事が投稿される。
 *
 * 同じ `idempotency_key` なら積み直さず、既にあることを返す。
 * **例外にしない** — 二度承認しても失敗させないため（F-6 の冪等性）。
 */
export async function enqueueJobInTx(
  tx: Prisma.TransactionClient,
  input: EnqueueJobInput,
): Promise<{ created: boolean }> {
  if (!isJobType(input.jobType)) {
    throw unknownJobTypeError(input.jobType);
  }

  assertIdempotencyKey(input.jobType, input.idempotencyKey);

  const existing = await tx.job.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });

  if (existing !== null) {
    return { created: false };
  }

  await tx.job.create({
    data: {
      jobType: input.jobType,
      idempotencyKey: input.idempotencyKey,
      inputJson: input.input as Prisma.InputJsonValue,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.blogId === undefined ? {} : { blogId: input.blogId }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    },
  });

  return { created: true };
}

/**
 * 失敗したジョブを積み直す（TASKS H-14、SPEC 13.7）。
 *
 * ## 新しい行を作らない
 *
 * **同じ冪等キーでは積めない**（C-4。`idempotency_key` は unique）。
 * かといってキーに通番を足すと、**キーの意味が「この対象の処理」から
 * 「この対象の何回目の処理」に変わり**、二重実行を止める働きが弱くなる。
 *
 * 代わりに**元の行を `QUEUED` へ戻す。** 冪等キーの意味は変わらず、
 * `attempt_count` を0に戻すだけで `claimNextJob` が拾えるようになる
 * （拾う条件が `attempt_count < MAX_ATTEMPTS` なので、
 * 上限に達した行はそのままでは二度と拾われない）。
 *
 * ## `FAILED` だけを積み直す
 *
 * `QUEUED` は放っておけば動く。`RUNNING` を戻すと**同じジョブが二重に
 * 走る**（動いている実行はこの操作を知らない）。`SUCCEEDED` を戻すのは
 * 「もう一度やる」であって再実行ではない。
 *
 * ## 中断の印を消す
 *
 * `output_json` の印（`performOnce`・C-4）が残っていると、**再実行しても
 * 毎回同じ理由で失敗する。** 印は「外部に副作用が残っているかもしれない」
 * という意味なので、**消すのは人が確かめた後だけ。**
 *
 * この操作そのものが「人が確かめた」の表明である。**消したことを
 * 監査ログに残す**のは呼び出し側（H-14 のAPI）。
 *
 * @returns 積み直した後のジョブ。**印が残っていたかも返す**
 * @throws {AppError} 見つからない・`FAILED` でない
 */
export async function retryJobForAdmin(jobId: string): Promise<{
  job: AppJob;
  /** 中断の印を消したか。**消したなら、外部の副作用が二重になりうる** */
  clearedCheckpoint: boolean;
}> {
  const current = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, outputJson: true },
  });

  if (current === null) {
    throw jobNotFoundError();
  }

  if (current.status !== 'FAILED') {
    throw jobNotRetryableError(current.status);
  }

  const clearedCheckpoint =
    typeof current.outputJson === 'object' &&
    current.outputJson !== null &&
    !Array.isArray(current.outputJson) &&
    CHECKPOINT_FIELD in current.outputJson;

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      // **0に戻す。** `claimNextJob` は上限に達した行を拾わない
      attemptCount: 0,
      // **前回の理由を残さない。** 直っていないのに古い理由が出ると、
      // 何度目の失敗なのか分からなくなる
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      // 中断の印ごと消す（上記）
      outputJson: Prisma.DbNull,
    },
    select: SELECT,
  });

  return { job: toAppJob(updated), clearedCheckpoint };
}

/**
 * 失敗したジョブを新しい順に返す（H-14、SPEC 13.7）。
 *
 * **ADMIN 専用**（MODULE_RULES 5）。名前で横断参照であることを示す。
 *
 * **`FAILED` だけを返す。** 積み直せるのはこれだけで、
 * 動いているジョブを並べても押せるボタンが無い。
 *
 * **入力と出力は返さない。** 記事本文も認証情報も入りうる（SPEC 14.2）。
 * どのジョブが、いつ、どんな理由で落ちたかが分かれば足りる。
 */
export async function listFailedJobsForAdmin(
  options: { limit?: number } = {},
): Promise<
  {
    id: string;
    jobType: string;
    userId: string | null;
    blogId: string | null;
    targetId: string | null;
    attemptCount: number;
    errorCode: string | null;
    errorMessage: string | null;
    completedAt: Date | null;
    createdAt: Date;
  }[]
> {
  return prisma.job.findMany({
    where: { status: 'FAILED' },
    orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
    // **際限なく返さない**（`listAuditLogsForAdmin` と同じ）
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    select: {
      id: true,
      jobType: true,
      userId: true,
      blogId: true,
      targetId: true,
      attemptCount: true,
      errorCode: true,
      errorMessage: true,
      completedAt: true,
      createdAt: true,
    },
  });
}
