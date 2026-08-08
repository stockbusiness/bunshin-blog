import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createLogger } from '@/lib/logger';
import {
  buildIdempotencyKey,
  claimNextJob,
  completeJob,
  drainJobs,
  enqueueJob,
  findJobById,
  performOnce,
  readCheckpoint,
  reclaimStuckJobs,
  saveJobCheckpoint,
  type AppJob,
} from '@/modules/jobs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * 「同一ジョブ再実行で二重投稿されない」を**実PostgreSQLで**確かめる
 * （TASKS C-4、SPEC 7.3）。
 *
 * 冪等性キーが守るのは積むところまでで、**実行の途中で落ちた場合**は
 * 別に手当てが要る。ここで再現するのは次の順序である。
 *
 * ```
 * ① 外部（WordPress）に作る   ← 成功
 * ② DBに記録する              ← ここへ来る前に関数が殺される
 * ```
 *
 * 印（`checkpoint.ts`）が無ければ、再試行は①をもう一度やる。
 * **やらないことを、やってしまう対照と並べて確かめる。**
 */

const TYPES = ['WORDPRESS_POST'] as const;
const silent = createLogger({ sink: () => undefined });

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

/** 実行中に関数が殺された状態を作る（`RUNNING` のまま放置） */
async function killWhileRunning(jobId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `update jobs set started_at = now() - interval '1 hour' where id = $1::uuid`,
    jobId,
  );
}

/** 再試行の待ち時間が過ぎた状態を作る */
async function ageJob(jobId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `update jobs set updated_at = now() - interval '1 hour' where id = $1::uuid`,
    jobId,
  );
}

function farDeadline(): Date {
  return new Date(Date.now() + 60_000);
}

describe('冪等性キー', () => {
  it('組み立てたキーで積める', async () => {
    const key = buildIdempotencyKey('WORDPRESS_POST', 'item-1');

    const { job, created } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: key,
      input: {},
    });

    expect(created).toBe(true);
    expect(job.idempotencyKey).toBe('WORDPRESS_POST:item-1');
  });

  /**
   * **種類をまたいだ衝突を防ぐ。** 対象（`content_item_id`）だけを
   * キーにすると、同じ記事の投稿と同期が同じキーになり、後から積んだ
   * ほうが黙って捨てられる。
   */
  it('同じ対象でも種類が違えば別のジョブとして積まれる', async () => {
    const post = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });
    const sync = await enqueueJob({
      jobType: 'WORDPRESS_SYNC',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_SYNC', 'item-1'),
      input: {},
    });

    expect(sync.created).toBe(true);
    expect(sync.job.id).not.toBe(post.job.id);
    expect(await prisma.job.count()).toBe(2);
  });

  it('種類が前置されていないキーは積む前に拒む', async () => {
    await expect(
      enqueueJob({
        jobType: 'WORDPRESS_POST',
        idempotencyKey: 'item-1',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'JOB_INVALID_IDEMPOTENCY_KEY' });

    expect(await prisma.job.count()).toBe(0);
  });

  it('別の種類のキーを拒む', async () => {
    await expect(
      enqueueJob({
        jobType: 'WORDPRESS_POST',
        idempotencyKey: 'WORDPRESS_SYNC:item-1',
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'JOB_INVALID_IDEMPOTENCY_KEY' });
  });
});

describe('印の保存', () => {
  it('書いた印を読み戻せる', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });

    await saveJobCheckpoint(job.id, {
      step: '下書き投稿',
      attempt: 1,
      at: '2026-08-08T00:00:00.000Z',
    });

    const reloaded = await findJobById(job.id);
    expect(readCheckpoint(reloaded as AppJob)).toEqual({
      step: '下書き投稿',
      attempt: 1,
      at: '2026-08-08T00:00:00.000Z',
    });
  });

  it('印を消せる', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });

    await saveJobCheckpoint(job.id, {
      step: '下書き投稿',
      attempt: 1,
      at: '2026-08-08T00:00:00.000Z',
    });
    await saveJobCheckpoint(job.id, null);

    expect(readCheckpoint((await findJobById(job.id)) as AppJob)).toBeNull();
  });

  // 印は「実行中の一時的な値」で、成功したら結果に置き換わる
  it('成功すると印は結果で上書きされる', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });
    const claimed = (await claimNextJob(TYPES)) as AppJob;

    await performOnce({
      job: claimed,
      step: '下書き投稿',
      perform: async () => 12,
    });

    // 呼び出し側がDBへ記録し終えるまで、印は残っている
    expect(
      readCheckpoint((await findJobById(job.id)) as AppJob),
    ).not.toBeNull();

    await completeJob(job.id, { wpPostId: 12 });

    const done = (await findJobById(job.id)) as AppJob;
    expect(readCheckpoint(done)).toBeNull();
    expect(done.output).toEqual({ wpPostId: 12 });
  });
});

describe('実行の途中で落ちた場合', () => {
  /** 外部に作られた「投稿」の数 */
  let posted: string[];

  beforeEach(() => {
    posted = [];
  });

  /**
   * ①だけ済ませて関数が殺される様子を作る。
   *
   * `drainJobs` を使わない。使うと落ちても `failJob` が呼ばれてしまい、
   * **殺された**状況にならない。
   */
  async function runAndDie(useGuard: boolean): Promise<string> {
    const claimed = (await claimNextJob(TYPES)) as AppJob;

    const create = async (): Promise<number> => {
      posted.push(`post-${posted.length + 1}`);

      return posted.length;
    };

    if (useGuard) {
      await performOnce({ job: claimed, step: '下書き投稿', perform: create });
    } else {
      await create();
    }

    // ②（DBへの記録）へ来る前に関数が殺された
    await killWhileRunning(claimed.id);

    return claimed.id;
  }

  /**
   * 中断を回収して、待ち時間を飛ばして、もう一度流す。
   *
   * 回収は `drainJobs` も行うが、回収は `updated_at` を現在に戻すため、
   * そのままでは待ち時間が明けない。**回収 → 時間を飛ばす → 実行**の
   * 順にする必要がある。
   */
  async function retry(useGuard: boolean): Promise<void> {
    await reclaimStuckJobs();

    const jobs = await prisma.job.findMany({ select: { id: true } });
    for (const job of jobs) {
      await ageJob(job.id);
    }

    await drainJobs({
      registry: {
        WORDPRESS_POST: async (job) => {
          const create = async (): Promise<number> => {
            posted.push(`post-${posted.length + 1}`);

            return posted.length;
          };

          return useGuard
            ? performOnce({ job, step: '下書き投稿', perform: create })
            : create();
        },
      },
      deadline: farDeadline(),
      logger: silent,
    });
  }

  /**
   * **対照。** 印が無ければ再試行は2本目を作る。
   * これが起きることを先に示さないと、下の検証が何も証明していない
   * ことになる。
   */
  it('印が無ければ二重投稿になる', async () => {
    await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });

    await runAndDie(false);
    await retry(false);

    expect(posted).toHaveLength(2);
  });

  // C-4 の完了条件
  it('印があれば二重投稿にならない', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });

    await runAndDie(true);
    await retry(true);

    expect(posted).toHaveLength(1);

    // やり直さずに止まり、理由が残る
    const row = await findJobById(job.id);
    expect(row?.errorCode).toBe('JOB_SIDE_EFFECT_UNCERTAIN');
  });

  /**
   * 印を残したまま試行の上限まで進み、`FAILED` で止まる。
   * **静かに消えない**（運用が気づける）。
   */
  it('やり直さないまま上限に達して止まる', async () => {
    const { job } = await enqueueJob({
      jobType: 'WORDPRESS_POST',
      idempotencyKey: buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      input: {},
    });

    await runAndDie(true);
    await retry(true);
    await retry(true);

    expect(posted).toHaveLength(1);

    const row = await findJobById(job.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toBe('JOB_SIDE_EFFECT_UNCERTAIN');
  });
});
