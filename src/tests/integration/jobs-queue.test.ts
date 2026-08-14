import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  BASE_BACKOFF_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  findJobByIdempotencyKey,
  reclaimStuckJobs,
} from '@/modules/jobs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * キューを**実PostgreSQLで**検証する（TASKS E-1）。
 *
 * `FOR UPDATE SKIP LOCKED`・待ち時間の判定・中断の回収は、いずれも
 * **SQLそのものが正しいかどうか**の話であり、差し替えでは確かめられない。
 */

const TYPES = ['WORDPRESS_POST'] as const;

let prisma: PrismaClient;

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

/** `updated_at` を過去へずらす（待ち時間の経過を作る） */
async function ageJob(jobId: string, seconds: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `update jobs set updated_at = now() - make_interval(secs => $2::double precision) where id = $1::uuid`,
    jobId,
    seconds,
  );
}

/** `started_at` を過去へずらす（中断の状況を作る） */
async function ageStart(jobId: string, seconds: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `update jobs set started_at = now() - make_interval(secs => $2::double precision) where id = $1::uuid`,
    jobId,
    seconds,
  );
}

describe('投入', () => {
  it('ジョブを積める', async () => {
    const { job, created } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:item-1',
      input: { contentItemId: 'item-1' },
    });

    expect(created).toBe(true);
    expect(job).toMatchObject({
      jobType: 'WORDPRESS_POST',
      status: 'QUEUED',
      attemptCount: 0,
    });
    expect(job.input).toEqual({ contentItemId: 'item-1' });
  });

  // SPEC 7.3「content_item_id ごとの冪等性キー」
  it('同じキーでは積み直さない', async () => {
    const first = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:item-1',
      input: { n: 1 },
    });
    const second = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:item-1',
      input: { n: 2 },
    });

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    // 後から来た入力で上書きしない
    expect(second.job.input).toEqual({ n: 1 });
    expect(await prisma.job.count()).toBe(1);
  });

  it('同時に投入しても1件しか積まれない', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        enqueueJob({
          jobType: 'WORDPRESS_POST',
          idempotencyKey: 'WORDPRESS_POST:same',
          input: {},
        }),
      ),
    );

    const created = results.filter(
      (item) => item.status === 'fulfilled' && item.value.created,
    );

    expect(created).toHaveLength(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it('知らない種類は拒否する', async () => {
    await expect(
      enqueueJob({
        jobType: 'NOT_A_JOB' as 'WORDPRESS_POST',
        idempotencyKey: 'x',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'JOB_UNKNOWN_TYPE' });
  });
});

describe('取得', () => {
  it('取ると RUNNING になり試行回数が増える', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });

    const claimed = await claimNextJob(TYPES);

    expect(claimed).toMatchObject({ status: 'RUNNING', attemptCount: 1 });
    expect(claimed?.startedAt).not.toBeNull();
  });

  it('登録していない種類は取らない', async () => {
    await enqueueJob({
      jobType: 'LINE_NOTIFY',
      idempotencyKey: 'LINE_NOTIFY:k1',
      input: {},
    });

    expect(await claimNextJob(TYPES)).toBeNull();
  });

  it('空の種類一覧では取らない', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });

    expect(await claimNextJob([])).toBeNull();
  });

  it('古いものから取る', async () => {
    const first = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k2',
      input: {},
    });

    expect((await claimNextJob(TYPES))?.id).toBe(first.job.id);
  });

  // ワーカーは並行して起動しうる。同じ行を二重に取ってはならない
  it('同時に取り合っても同じ行を2回取らない', async () => {
    for (let index = 0; index < 3; index += 1) {
      await enqueueJob({
        jobType: 'WORDPRESS_POST',
        idempotencyKey: `WORDPRESS_POST:k${index}`,
        input: {},
      });
    }

    const claimed = await Promise.all([
      claimNextJob(TYPES),
      claimNextJob(TYPES),
      claimNextJob(TYPES),
    ]);

    const ids = claimed.map((job) => job?.id).filter(Boolean);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  /**
   * **`FOR UPDATE SKIP LOCKED` そのものの確認。**
   *
   * `Promise.all` は接続プールの都合で本当に競合しないことがある。
   * 別トランザクションで先頭の行を明示的にロックし、取得が
   * **待たずに次の行へ進む**ことを確かめる。
   */
  it('ロックされた行を待たずに飛ばす', async () => {
    const first = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    const second = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k2',
      input: {},
    });

    const claimed = await prisma.$transaction(async (tx) => {
      // 先頭の行を掴んだまま離さない
      await tx.$queryRawUnsafe(
        `select id from jobs where id = $1::uuid for update`,
        first.job.id,
      );

      // 別接続からの取得。SKIP LOCKED が効いていなければここで固まる
      return claimNextJob(TYPES);
    });

    expect(claimed?.id).toBe(second.job.id);

    // ロックが解けたあとは先頭も取れる
    expect((await claimNextJob(TYPES))?.id).toBe(first.job.id);
  });

  it('RUNNING のものは取らない', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });

    expect(await claimNextJob(TYPES)).not.toBeNull();
    expect(await claimNextJob(TYPES)).toBeNull();
  });
});

describe('待ち時間（再試行）', () => {
  async function claimAndFail(): Promise<string> {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: `WORDPRESS_POST:k-${Math.random()}`,
      input: {},
    });
    await claimNextJob(TYPES);
    await failJob(job.id, { code: 'X', message: '失敗' });

    return job.id;
  }

  it('失敗すると QUEUED へ戻る', async () => {
    const jobId = await claimAndFail();

    const row = await prisma.job.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe('QUEUED');
    expect(row?.attemptCount).toBe(1);
    expect(row?.startedAt).toBeNull();
  });

  // ここが `updated_at` を待ち時間の基準に使っている箇所
  it('待ち時間が過ぎるまで取れない', async () => {
    await claimAndFail();

    expect(await claimNextJob(TYPES)).toBeNull();
  });

  it('待ち時間が過ぎたら取れる', async () => {
    const jobId = await claimAndFail();
    await ageJob(jobId, BASE_BACKOFF_SECONDS + 5);

    const claimed = await claimNextJob(TYPES);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attemptCount).toBe(2);
  });

  it('試行ごとに待ち時間が延びる', async () => {
    const jobId = await claimAndFail();

    await ageJob(jobId, BASE_BACKOFF_SECONDS + 5);
    await claimNextJob(TYPES);
    await failJob(jobId, { code: 'X', message: '失敗' });

    // 1回目と同じだけ待っても、2回目は取れない
    await ageJob(jobId, BASE_BACKOFF_SECONDS + 5);
    expect(await claimNextJob(TYPES)).toBeNull();

    await ageJob(jobId, BASE_BACKOFF_SECONDS * 2 + 5);
    expect((await claimNextJob(TYPES))?.id).toBe(jobId);
  });

  it('上限に達したら FAILED で固定し、取らない', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await ageJob(job.id, BASE_BACKOFF_SECONDS * 2 ** attempt + 10);
      const claimed = await claimNextJob(TYPES);
      expect(claimed?.id).toBe(job.id);
      await failJob(job.id, { code: 'X', message: '失敗' });
    }

    const row = await prisma.job.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe('FAILED');
    expect(row?.attemptCount).toBe(MAX_ATTEMPTS);
    expect(row?.completedAt).not.toBeNull();

    await ageJob(job.id, 100_000);
    expect(await claimNextJob(TYPES)).toBeNull();
  });
});

describe('中断の回収（サーバーレスで必須）', () => {
  // 関数が実行時間の上限で殺されると、行は RUNNING のまま残る
  it('RUNNING のまま古くなった行を QUEUED へ戻す', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await claimNextJob(TYPES);
    await ageStart(job.id, LEASE_SECONDS + 10);

    expect(await reclaimStuckJobs()).toBe(1);

    const row = await prisma.job.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe('QUEUED');
    expect(row?.startedAt).toBeNull();
    expect(row?.errorCode).toBe('JOB_TIMEOUT');
  });

  it('まだ動いているかもしれない行は戻さない', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await claimNextJob(TYPES);

    expect(await reclaimStuckJobs()).toBe(0);
  });

  // 毎回タイムアウトするジョブが無限に再試行されるのを防ぐ
  it('回収しても試行回数は戻さない', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await claimNextJob(TYPES);
    await ageStart(job.id, LEASE_SECONDS + 10);
    await reclaimStuckJobs();

    const row = await prisma.job.findUnique({ where: { id: job.id } });
    expect(row?.attemptCount).toBe(1);
  });

  it('回収を繰り返しても上限で止まる', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await ageJob(job.id, BASE_BACKOFF_SECONDS * 2 ** attempt + 10);
      await claimNextJob(TYPES);
      await ageStart(job.id, LEASE_SECONDS + 10);
      await reclaimStuckJobs();
    }

    await ageJob(job.id, 100_000);
    expect(await claimNextJob(TYPES)).toBeNull();
  });
});

describe('完了', () => {
  it('成功として記録する', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await claimNextJob(TYPES);

    const done = await completeJob(job.id, { wpPostId: 42 });

    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      output: { wpPostId: 42 },
    });
    expect(done.completedAt).not.toBeNull();
  });

  it('成功したジョブは取られない', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:k1',
      input: {},
    });
    await claimNextJob(TYPES);
    await completeJob(job.id, null);

    await ageJob(job.id, 100_000);
    expect(await claimNextJob(TYPES)).toBeNull();
  });

  it('冪等性キーで引ける', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: 'WORDPRESS_POST:item-9',
      input: {},
    });

    expect(
      (await findJobByIdempotencyKey('WORDPRESS_POST:item-9'))?.jobType,
    ).toBe('WORDPRESS_POST');
    expect(await findJobByIdempotencyKey('missing')).toBeNull();
  });
});
