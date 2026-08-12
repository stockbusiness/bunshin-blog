import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  CHECKPOINT_FIELD,
  MAX_ATTEMPTS,
  claimNextJob,
  enqueueJob,
  failJob,
  listFailedJobsForAdmin,
  retryJobForAdmin,
} from '@/modules/jobs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * 失敗したジョブの積み直しを**実PostgreSQLで**確かめる（TASKS H-14、
 * SPEC 13.7・14.4）。
 *
 * **`claimNextJob` が拾えるようになること**がこの試験の中心 —
 * 状態を `QUEUED` に戻すだけでは足りない。拾う条件が
 * `attempt_count < MAX_ATTEMPTS` なので、**上限に達した行は
 * そのままでは二度と拾われない。**
 */

let prisma: PrismaClient;

const JOB_TYPE = 'LINK_CHECK';

/**
 * 上限まで失敗させて `FAILED` にする。
 *
 * **失敗を繰り返すループでは作れない。** `claimNextJob` はバックオフ
 * （`updated_at <= now() - 待ち時間`）を見るので、2回目以降はその場では
 * 拾われない。試行回数を上限に合わせてから `failJob` を通す
 */
async function failedJob(key = 'target-1'): Promise<string> {
  const { job } = await enqueueJob({
    jobType: JOB_TYPE,
    idempotencyKey: `${JOB_TYPE}:${key}`,
    input: { blogId: 'blog-1' },
  });

  await claimNextJob([JOB_TYPE]);
  await prisma.job.update({
    where: { id: job.id },
    data: { attemptCount: MAX_ATTEMPTS },
  });
  // **`failJob` を通す。** 上限に達した扱いはあちらが決める
  await failJob(job.id, { code: 'BOOM', message: '落ちました' });

  return job.id;
}

function readJob(jobId: string) {
  return prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      status: true,
      attemptCount: true,
      errorCode: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
      outputJson: true,
    },
  });
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('積み直し', () => {
  it('FAILED を QUEUED へ戻し、試行回数を0にする', async () => {
    const jobId = await failedJob();

    expect((await readJob(jobId)).status).toBe('FAILED');

    const { clearedCheckpoint } = await retryJobForAdmin(jobId);

    expect(clearedCheckpoint).toBe(false);
    expect(await readJob(jobId)).toMatchObject({
      status: 'QUEUED',
      attemptCount: 0,
      // **前回の理由を残さない。** 直っていないのに古い理由が出ると、
      // 何度目の失敗なのか分からなくなる
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });
  });

  /**
   * **ここがこの試験の中心。** 状態を戻すだけでは拾われない
   * （`attempt_count < MAX_ATTEMPTS` が拾う条件）
   */
  it('積み直した後、ワーカーが拾える', async () => {
    const jobId = await failedJob();

    expect(await claimNextJob([JOB_TYPE])).toBeNull();

    await retryJobForAdmin(jobId);

    const claimed = await claimNextJob([JOB_TYPE]);

    expect(claimed?.id).toBe(jobId);
  });

  /**
   * **新しい行を作らない。** 同じ冪等キーでは積めず（C-4）、
   * キーに通番を足すと**二重実行を止める働きが弱くなる**
   */
  it('行が増えない', async () => {
    const jobId = await failedJob();

    await retryJobForAdmin(jobId);

    expect(await prisma.job.count()).toBe(1);
  });
});

/** 動いているジョブを戻すと、同じジョブが二重に走る */
describe('積み直せない状態', () => {
  it.each([
    { name: 'QUEUED', status: 'QUEUED' as const },
    { name: 'RUNNING', status: 'RUNNING' as const },
    { name: 'SUCCEEDED', status: 'SUCCEEDED' as const },
  ])('$name は積み直せない（409）', async ({ status }) => {
    const jobId = await failedJob();
    await prisma.job.update({ where: { id: jobId }, data: { status } });

    await expect(retryJobForAdmin(jobId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('無いジョブは404', async () => {
    await expect(
      retryJobForAdmin('00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * 中断の印（`performOnce`・C-4）。
 *
 * **残っていると再実行は毎回同じ理由で失敗する。** 印は
 * 「外部に副作用が残っているかもしれない」という意味で、
 * **消すのは人が確かめた後だけ。**
 */
describe('中断の印', () => {
  async function withCheckpoint(): Promise<string> {
    const jobId = await failedJob();

    await prisma.job.update({
      where: { id: jobId },
      data: {
        outputJson: {
          [CHECKPOINT_FIELD]: {
            step: 'wordpress.createDraft',
            attempt: 1,
            at: '2026-08-12T00:00:00.000Z',
          },
        },
      },
    });

    return jobId;
  }

  it('印を消して、消したことを返す', async () => {
    const jobId = await withCheckpoint();

    const { clearedCheckpoint } = await retryJobForAdmin(jobId);

    // **消したなら、外部の副作用が二重になりうる**。呼び出し側が知る必要がある
    expect(clearedCheckpoint).toBe(true);
    expect((await readJob(jobId)).outputJson).toBeNull();
  });

  it('印が無ければ false', async () => {
    const jobId = await failedJob();

    expect((await retryJobForAdmin(jobId)).clearedCheckpoint).toBe(false);
  });
});

describe('一覧', () => {
  it('FAILED だけを返す', async () => {
    const failed = await failedJob('target-1');
    await enqueueJob({
      jobType: JOB_TYPE,
      idempotencyKey: `${JOB_TYPE}:target-2`,
      input: {},
    });

    const jobs = await listFailedJobsForAdmin();

    expect(jobs.map((job) => job.id)).toEqual([failed]);
  });

  it('積み直したものは一覧から消える', async () => {
    const jobId = await failedJob();

    await retryJobForAdmin(jobId);

    expect(await listFailedJobsForAdmin()).toEqual([]);
  });

  /**
   * **入力と出力を返さない。** 記事本文も認証情報も入りうる（SPEC 14.2）
   */
  it('入力と出力を返さない', async () => {
    await failedJob();

    const [job] = await listFailedJobsForAdmin();

    expect(job).not.toHaveProperty('inputJson');
    expect(job).not.toHaveProperty('outputJson');
  });
});
