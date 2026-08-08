import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  DEADLINE_MARGIN_MS,
  JOB_ERROR_CODES,
  drainJobs,
  type AppJob,
  type JobHandlerRegistry,
  type JobRunnerDeps,
} from '@/modules/jobs';

/**
 * ジョブの実行ループ（TASKS E-1）。
 *
 * DBは差し替える（SQLの正しさは統合テストの担当）。ここで確かめるのは
 * **締め切りで抜けること**と**失敗の扱い**。サーバーレスでは、
 * 締め切りを守れないと関数ごと殺されて結果が記録されない。
 */

const silent = createLogger({ sink: () => undefined });

function makeJob(overrides: Partial<AppJob> = {}): AppJob {
  return {
    id: 'job-1',
    jobType: 'WORDPRESS_POST',
    userId: null,
    blogId: null,
    targetId: null,
    status: 'RUNNING',
    attemptCount: 1,
    idempotencyKey: 'key-1',
    input: {},
    output: null,
    errorCode: null,
    errorMessage: null,
    startedAt: new Date('2026-08-08T00:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    ...overrides,
  };
}

interface FakeDeps {
  deps: JobRunnerDeps;
  completed: { jobId: string; output: unknown }[];
  failed: { jobId: string; code: string; message: string }[];
  claims: number;
}

function createDeps(
  jobs: AppJob[],
  options: { reclaimed?: number; failStatus?: AppJob['status'] } = {},
): FakeDeps {
  const queue = [...jobs];
  const completed: FakeDeps['completed'] = [];
  const failed: FakeDeps['failed'] = [];
  const state = { claims: 0 };

  const deps: JobRunnerDeps = {
    async reclaimStuckJobs() {
      return options.reclaimed ?? 0;
    },
    async claimNextJob() {
      state.claims += 1;
      return queue.shift() ?? null;
    },
    async completeJob(jobId, output) {
      completed.push({ jobId, output });
      return makeJob({ id: jobId, status: 'SUCCEEDED', output });
    },
    async failJob(jobId, failure) {
      failed.push({ jobId, ...failure });
      return makeJob({
        id: jobId,
        status: options.failStatus ?? 'QUEUED',
        errorCode: failure.code,
      });
    },
  };

  return {
    deps,
    completed,
    failed,
    get claims() {
      return state.claims;
    },
  };
}

/** 十分に先の締め切り */
function farDeadline(): Date {
  return new Date(Date.now() + 60_000);
}

describe('drainJobs', () => {
  it('登録されたハンドラでジョブを処理する', async () => {
    const fake = createDeps([makeJob()]);
    const registry: JobHandlerRegistry = {
      WORDPRESS_POST: async () => ({ ok: true }),
    };

    const result = await drainJobs({
      registry,
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(fake.completed).toEqual([{ jobId: 'job-1', output: { ok: true } }]);
  });

  it('取れなくなったら抜ける', async () => {
    const fake = createDeps([makeJob({ id: 'a' }), makeJob({ id: 'b' })]);

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(result.succeeded).toBe(2);
    // 2件取ったあと、空を確認する3回目で終わる
    expect(fake.claims).toBe(3);
    expect(result.stoppedByDeadline).toBe(false);
  });

  it('中断されたジョブを戻した件数を返す', async () => {
    const fake = createDeps([], { reclaimed: 2 });

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(result.reclaimed).toBe(2);
  });

  it('ハンドラが1つも無ければジョブを取らない', async () => {
    const fake = createDeps([makeJob()]);

    const result = await drainJobs({
      registry: {},
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(fake.claims).toBe(0);
    expect(result.succeeded).toBe(0);
  });
});

describe('締め切り', () => {
  // サーバーレスでは、締め切りを守れないと関数ごと殺されて結果が残らない
  it('締め切りを過ぎていれば1件も取らない', async () => {
    const fake = createDeps([makeJob()]);

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      deadline: new Date(Date.now() - 1),
      deps: fake.deps,
      logger: silent,
    });

    expect(fake.claims).toBe(0);
    expect(result.stoppedByDeadline).toBe(true);
  });

  it('余裕を残して止める', async () => {
    const fake = createDeps([makeJob()]);

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      // 余裕ぶんしか残っていない
      deadline: new Date(Date.now() + DEADLINE_MARGIN_MS - 100),
      deps: fake.deps,
      logger: silent,
    });

    expect(fake.claims).toBe(0);
    expect(result.stoppedByDeadline).toBe(true);
  });

  it('締め切りに達したら残りを次に回す', async () => {
    const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b' })];
    const fake = createDeps(jobs);
    let calls = 0;
    // 1件処理したところで締め切りを跨ぐ
    const start = Date.now();
    const deadline = new Date(start + 10_000);
    const now = (): Date => {
      calls += 1;

      return calls <= 1 ? new Date(start) : new Date(start + 10_000);
    };

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      deadline,
      deps: fake.deps,
      now,
      logger: silent,
    });

    expect(result.succeeded).toBe(1);
    expect(result.stoppedByDeadline).toBe(true);
  });
});

describe('失敗の扱い', () => {
  it('例外を失敗として記録し、次のジョブへ進む', async () => {
    const fake = createDeps([makeJob({ id: 'a' }), makeJob({ id: 'b' })]);
    let first = true;

    const result = await drainJobs({
      registry: {
        WORDPRESS_POST: async () => {
          if (first) {
            first = false;
            throw new Error('失敗した');
          }

          return null;
        },
      },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(fake.failed[0]).toMatchObject({
      jobId: 'a',
      code: JOB_ERROR_CODES.handlerFailed,
      message: '失敗した',
    });
  });

  it('AppError はコードを保つ', async () => {
    const fake = createDeps([makeJob()]);

    await drainJobs({
      registry: {
        WORDPRESS_POST: async () => {
          throw new AppError('WORDPRESS_POST_FAILED', 502, '投稿できません');
        },
      },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(fake.failed[0]).toMatchObject({
      code: 'WORDPRESS_POST_FAILED',
      message: '投稿できません',
    });
  });

  it('例外でない値を投げられても記録する', async () => {
    const fake = createDeps([makeJob()]);

    await drainJobs({
      registry: {
        WORDPRESS_POST: async () => {
          throw 'ただの文字列';
        },
      },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(fake.failed[0]?.code).toBe(JOB_ERROR_CODES.handlerFailed);
  });

  // 1件に引きずられてワーカー全体が殺されるのを避ける
  it('1件が長引いたらタイムアウトとして記録する', async () => {
    vi.useFakeTimers();
    try {
      const fake = createDeps([makeJob()]);

      const promise = drainJobs({
        registry: {
          WORDPRESS_POST: () => new Promise(() => undefined),
        },
        deadline: new Date(Date.now() + 600_000),
        jobTimeoutMs: 1000,
        deps: fake.deps,
        logger: silent,
      });

      await vi.advanceTimersByTimeAsync(1500);
      const result = await promise;

      expect(result.failed).toBe(1);
      expect(fake.failed[0]?.code).toBe(JOB_ERROR_CODES.jobTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ハンドラが無い種類は失敗にして残さない', async () => {
    const fake = createDeps([makeJob({ jobType: 'LINE_NOTIFY' })]);

    const result = await drainJobs({
      registry: { WORDPRESS_POST: async () => null },
      deadline: farDeadline(),
      deps: fake.deps,
      logger: silent,
    });

    expect(result.failed).toBe(1);
    expect(fake.failed[0]?.code).toBe(JOB_ERROR_CODES.noHandler);
  });
});
