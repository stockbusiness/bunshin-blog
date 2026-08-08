/**
 * 外部への副作用を一度きりに保つ（TASKS C-4、SPEC 7.3）。
 *
 * ## 何を解こうとしているか
 *
 * 冪等性キー（`idempotency.ts`）が守るのは**積むところまで**である。
 * 同じキーなら行は増えない。しかし SPEC 7.3 の「同一ジョブ再実行で
 * 二重投稿されない」は、**実行の途中で落ちた場合**まで含む。
 *
 * ```
 * ① WordPress に下書きを作る（HTTP）   ← ここで成功
 * ② wordpress_posts に記録する（DB）   ← ここへ来る前に関数が殺される
 * ```
 *
 * この状態で再試行すると、DBには記録が無いので「まだ投稿していない」と
 * 判断し、**2本目の下書きを作る**。Vercel の関数は実行時間の上限で
 * 途中から殺されるため、これは理論上の話ではない。
 *
 * ## どう解くか
 *
 * **外部を呼ぶ直前に、呼ぶことをジョブ自身に書き残す。** 再試行時に
 * その印が残っていれば、前回が①と②の間で落ちたことが分かる。
 * 分かった上で、**やり直さずに失敗させる**。
 *
 * 「2本目を作る」より「止まって人に見せる」ほうが安全である。
 * 二重投稿は実験データを壊し、モニターのブログに要らない記事を残す。
 * 止まったジョブは `error_code` を見て手で直せる（H-6 の運用手順）。
 *
 * ## 印の置き場所
 *
 * `jobs.output_json` を使う。**専用の列を足さない**（スキーマ変更は
 * 単独のPRにする決まりで、C-4 の変更先は `src/modules/jobs/` である）。
 * `output_json` は成功時にしか書かれないため、実行中は空いている。
 * 成功すれば `completeJob` が結果で上書きし、印は消える。
 *
 * ## 制約：一度きりの外部呼び出しは、1ジョブに1つまで
 *
 * 印は1つしか持たない。2つ以上の取り消せない副作用を持つ処理は、
 * **ジョブを分ける**こと。1つのジョブに詰め込むと、どこまで進んだかを
 * 印だけでは表せなくなる。
 */

import { AppError } from '@/lib/errors';
import { JOB_ERROR_CODES } from './errors';
import type { AppJob } from './types';

/** `output_json` の中で印を置く場所 */
export const CHECKPOINT_FIELD = '__checkpoint';

export interface JobCheckpoint {
  /** 何を呼ぼうとしていたか */
  step: string;
  /** 何回目の試行で呼ぼうとしたか */
  attempt: number;
  /** 呼ぶ直前の時刻（ISO 8601） */
  at: string;
}

/** 印を書く。`null` で消す */
export type SaveCheckpoint = (
  jobId: string,
  checkpoint: JobCheckpoint | null,
) => Promise<void>;

/**
 * 前回の実行が外部呼び出しの最中に中断したことを表す。
 *
 * **再試行しない前提のエラー。** 印が残っている限り毎回これになり、
 * 試行の上限に達して `FAILED` で止まる。
 */
export function sideEffectUncertainError(
  step: string,
  previous: JobCheckpoint,
): AppError {
  return new AppError(
    JOB_ERROR_CODES.sideEffectUncertain,
    409,
    `前回の実行が「${step}」の最中に中断しました（${previous.attempt}回目、${previous.at}）。` +
      '外部側に副作用が残っている可能性があるため、やり直しません。手で確認してください',
  );
}

function isCheckpoint(value: unknown): value is JobCheckpoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record['step'] === 'string' &&
    typeof record['attempt'] === 'number' &&
    typeof record['at'] === 'string'
  );
}

/** ジョブに残っている印。無ければ `null` */
export function readCheckpoint(job: AppJob): JobCheckpoint | null {
  const output = job.output;
  if (typeof output !== 'object' || output === null) {
    return null;
  }

  const value = (output as Record<string, unknown>)[CHECKPOINT_FIELD];

  return isCheckpoint(value) ? value : null;
}

export interface PerformOnceOptions<T> {
  job: AppJob;
  /** 印に残す名前。ログとエラーに出る */
  step: string;
  /** 取り消せない外部呼び出し */
  perform: () => Promise<T>;
  /**
   * この失敗なら**副作用は出ていないと確実に言える**か。
   *
   * 既定は「言えない」（`false`）。**安全側に倒す。** 判断を間違えて
   * `true` を返すと二重投稿になる。
   *
   * 言えるのは、要求が相手に届いていないか、届いた上で作らずに
   * 拒否されたと分かる場合に限る（接続拒否、名前解決の失敗、
   * 401・403 など）。タイムアウトと 5xx は**言えない**。
   */
  isSafeToRetry?: (error: unknown) => boolean;
  now?: () => Date;
  /** 差し替え用。既定は `repository.ts` */
  save?: SaveCheckpoint;
}

/**
 * 取り消せない外部呼び出しを、再実行しても一度きりにする。
 *
 * **「もう済んでいるか」の判定は呼び出し側の仕事。** 例えば下書き投稿なら
 * `wordpress_posts` に行があるかを先に見て、あれば更新の経路へ進む
 * （C-3 で実装済み）。ここが守るのは、その判定では拾えない
 * 「①は済んだが②が残っていない」状態だけである。
 *
 * @throws {AppError} 前回が中断していた場合（`JOB_SIDE_EFFECT_UNCERTAIN`）
 */
export async function performOnce<T>(
  options: PerformOnceOptions<T>,
): Promise<T> {
  const { job, step } = options;
  const now = options.now ?? (() => new Date());
  const isSafeToRetry = options.isSafeToRetry ?? (() => false);
  const save = options.save ?? (await defaultSave());

  const previous = readCheckpoint(job);
  if (previous !== null) {
    throw sideEffectUncertainError(step, previous);
  }

  await save(job.id, {
    step,
    attempt: job.attemptCount,
    at: now().toISOString(),
  });

  try {
    return await options.perform();
  } catch (error) {
    // **副作用が出ていないと確実に言える失敗だけ、印を消す。**
    // 消さないと、接続できなかっただけのジョブが二度と再試行されない
    if (isSafeToRetry(error)) {
      await save(job.id, null);
    }

    throw error;
  }

  // 成功しても印は消さない。呼び出し側がDBへ記録し終えるまでが危険な区間で、
  // 記録まで終われば `completeJob` が `output_json` を結果で上書きする
}

async function defaultSave(): Promise<SaveCheckpoint> {
  const repository = await import('./repository');

  return repository.saveJobCheckpoint;
}
