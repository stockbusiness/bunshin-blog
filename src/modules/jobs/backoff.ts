/**
 * 再試行の間隔と上限（TASKS E-1）。
 *
 * DBもネットワークも触らない純粋な処理。**SQL側と同じ式を使う**ため、
 * ここを変えるときは `repository.ts` の取得条件も揃えること。
 */

/** 最大試行回数。これを超えたら `FAILED` で固定し、自動では再試行しない */
export const MAX_ATTEMPTS = 3;

/** 1回目の失敗後に待つ秒数 */
export const BASE_BACKOFF_SECONDS = 60;

/** 待ち時間の上限。これ以上は延ばさない */
export const MAX_BACKOFF_SECONDS = 1800;

/**
 * `RUNNING` のまま放置された行を回収するまでの秒数。
 *
 * **関数のタイムアウトより十分に長くする。** Vercel の関数は上限を超えると
 * 途中で殺され、`RUNNING` の行がそのまま残る。短すぎると、まだ動いている
 * ジョブを二重に走らせる。
 */
export const LEASE_SECONDS = 600;

/**
 * 次の試行までに待つ秒数。
 *
 * `attemptCount` は**その時点までに試した回数**。0（未試行）なら待たない。
 */
export function backoffSeconds(attemptCount: number): number {
  if (attemptCount <= 0) {
    return 0;
  }

  const delay = BASE_BACKOFF_SECONDS * 2 ** (attemptCount - 1);

  return Math.min(delay, MAX_BACKOFF_SECONDS);
}

/** これ以上試さないか */
export function isExhausted(attemptCount: number): boolean {
  return attemptCount >= MAX_ATTEMPTS;
}

/**
 * 次に試せる時刻。
 *
 * 基準は**最後に状態が変わった時刻**（`updated_at`）。失敗して `QUEUED` へ
 * 戻した時刻がそれにあたる。専用の列を持たずに待ち時間を表現できる。
 */
export function nextAttemptAt(params: {
  updatedAt: Date;
  attemptCount: number;
}): Date {
  return new Date(
    params.updatedAt.getTime() + backoffSeconds(params.attemptCount) * 1000,
  );
}
