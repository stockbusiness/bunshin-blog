import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  CHECKPOINT_FIELD,
  JOB_ERROR_CODES,
  performOnce,
  readCheckpoint,
  type AppJob,
  type JobCheckpoint,
} from '@/modules/jobs';

/**
 * 外部呼び出しを一度きりに保つ（TASKS C-4、SPEC 7.3）。
 *
 * ここで確かめるのは**「WordPress に投稿はしたが、記録の前に落ちた」
 * 状態から再実行したときに、2本目を作らないこと**。
 */

function makeJob(overrides: Partial<AppJob> = {}): AppJob {
  return {
    id: 'job-1',
    jobType: 'WORDPRESS_POST',
    userId: null,
    blogId: null,
    targetId: null,
    status: 'RUNNING',
    attemptCount: 1,
    idempotencyKey: 'WORDPRESS_POST:item-1',
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

/** 印を持ったジョブ（前回が中断した状態） */
function withCheckpoint(checkpoint: Partial<JobCheckpoint> = {}): AppJob {
  return makeJob({
    attemptCount: 2,
    output: {
      [CHECKPOINT_FIELD]: {
        step: '下書き投稿',
        attempt: 1,
        at: '2026-08-08T00:00:00.000Z',
        ...checkpoint,
      },
    },
  });
}

interface Recorder {
  save: (jobId: string, checkpoint: JobCheckpoint | null) => Promise<void>;
  writes: (JobCheckpoint | null)[];
}

function createRecorder(): Recorder {
  const writes: (JobCheckpoint | null)[] = [];

  return {
    writes,
    async save(_jobId, checkpoint) {
      writes.push(checkpoint);
    },
  };
}

const now = (): Date => new Date('2026-08-08T12:00:00Z');

describe('readCheckpoint', () => {
  it('印が無ければ null', () => {
    expect(readCheckpoint(makeJob())).toBeNull();
  });

  it('印を読める', () => {
    expect(readCheckpoint(withCheckpoint())).toMatchObject({
      step: '下書き投稿',
      attempt: 1,
    });
  });

  // 成功したジョブの `output_json` は結果で上書きされている。
  // 形の違う値を印として読み取らない
  it.each([
    [{ wpPostId: 12 }],
    [{ [CHECKPOINT_FIELD]: 'draft' }],
    [{ [CHECKPOINT_FIELD]: { step: '投稿' } }],
    [{ [CHECKPOINT_FIELD]: null }],
  ])('印でない値を印として読まない: %o', (output) => {
    expect(readCheckpoint(makeJob({ output }))).toBeNull();
  });

  it.each([[null], ['文字列'], [42], [[]]])(
    'output が %o でも落ちない',
    (output) => {
      expect(readCheckpoint(makeJob({ output }))).toBeNull();
    },
  );
});

describe('performOnce', () => {
  it('印を残してから呼ぶ', async () => {
    const recorder = createRecorder();
    const order: string[] = [];

    const result = await performOnce({
      job: makeJob(),
      step: '下書き投稿',
      now,
      save: async (jobId, checkpoint) => {
        order.push('save');
        await recorder.save(jobId, checkpoint);
      },
      perform: async () => {
        order.push('perform');

        return 12;
      },
    });

    expect(result).toBe(12);
    // **順序が逆だと意味が無い。** 呼んだ後に書いても、その間に落ちれば印は残らない
    expect(order).toEqual(['save', 'perform']);
    expect(recorder.writes[0]).toEqual({
      step: '下書き投稿',
      attempt: 1,
      at: '2026-08-08T12:00:00.000Z',
    });
  });

  /**
   * 成功しても印を消さない。呼び出し側がDBへ記録し終えるまでが危険な区間で、
   * その記録は `performOnce` の外にある。
   */
  it('成功しても印を消さない', async () => {
    const recorder = createRecorder();

    await performOnce({
      job: makeJob(),
      step: '下書き投稿',
      now,
      save: recorder.save,
      perform: async () => 12,
    });

    expect(recorder.writes).toHaveLength(1);
    expect(recorder.writes[0]).not.toBeNull();
  });

  // C-4 の完了条件そのもの
  it('前回が中断していたら、やり直さずに失敗する', async () => {
    const recorder = createRecorder();
    let called = 0;

    const error = await performOnce({
      job: withCheckpoint(),
      step: '下書き投稿',
      now,
      save: recorder.save,
      perform: async () => {
        called += 1;

        return 12;
      },
    }).catch((caught: unknown) => caught);

    expect(called).toBe(0);
    expect(recorder.writes).toHaveLength(0);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(JOB_ERROR_CODES.sideEffectUncertain);
  });

  // 別の名前で呼び直しても抜けられない（印は1ジョブに1つ）
  it('別の step でも印が残っていれば失敗する', async () => {
    await expect(
      performOnce({
        job: withCheckpoint(),
        step: '別の呼び出し',
        now,
        save: createRecorder().save,
        perform: async () => 12,
      }),
    ).rejects.toMatchObject({ code: JOB_ERROR_CODES.sideEffectUncertain });
  });

  it('中断の回数と時刻をエラーに含める', async () => {
    const error = await performOnce({
      job: withCheckpoint({ attempt: 2, at: '2026-08-07T09:30:00.000Z' }),
      step: '下書き投稿',
      now,
      save: createRecorder().save,
      perform: async () => 12,
    }).catch((caught: unknown) => caught);

    expect((error as AppError).message).toContain('2回目');
    expect((error as AppError).message).toContain('2026-08-07T09:30:00.000Z');
  });
});

describe('失敗したときの印', () => {
  /**
   * **既定は残す。** 副作用が出たかどうか分からない失敗（タイムアウト、
   * 5xx、切断）で消してしまうと、2本目を作る道が開く。
   */
  it('既定では印を消さない', async () => {
    const recorder = createRecorder();

    await expect(
      performOnce({
        job: makeJob(),
        step: '下書き投稿',
        now,
        save: recorder.save,
        perform: async () => {
          throw new Error('タイムアウト');
        },
      }),
    ).rejects.toThrow('タイムアウト');

    expect(recorder.writes).toEqual([
      { step: '下書き投稿', attempt: 1, at: '2026-08-08T12:00:00.000Z' },
    ]);
  });

  /**
   * 副作用が出ていないと**確実に言える**失敗だけ消す。
   * 消さないと、接続できなかっただけのジョブが二度と再試行されない。
   */
  it('安全だと判定した失敗では印を消す', async () => {
    const recorder = createRecorder();

    await expect(
      performOnce({
        job: makeJob(),
        step: '下書き投稿',
        now,
        save: recorder.save,
        isSafeToRetry: (error) =>
          error instanceof Error && error.message === '接続できません',
        perform: async () => {
          throw new Error('接続できません');
        },
      }),
    ).rejects.toThrow('接続できません');

    expect(recorder.writes).toEqual([
      { step: '下書き投稿', attempt: 1, at: '2026-08-08T12:00:00.000Z' },
      null,
    ]);
  });

  it('判定に当てはまらない失敗では印を残す', async () => {
    const recorder = createRecorder();

    await expect(
      performOnce({
        job: makeJob(),
        step: '下書き投稿',
        now,
        save: recorder.save,
        isSafeToRetry: (error) =>
          error instanceof Error && error.message === '接続できません',
        perform: async () => {
          throw new Error('応答がありません');
        },
      }),
    ).rejects.toThrow('応答がありません');

    expect(recorder.writes).toHaveLength(1);
  });
});
