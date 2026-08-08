import { describe, expect, it } from 'vitest';
import {
  BASE_BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_SECONDS,
  backoffSeconds,
  isExhausted,
  nextAttemptAt,
} from '@/modules/jobs';

/**
 * 再試行の間隔と上限（TASKS E-1）。
 *
 * **SQL側（`repository.ts` の取得条件）と同じ式**であることが前提。
 * 片方だけ変えると、待っているつもりのジョブが取られる。
 */

describe('backoffSeconds', () => {
  it('未試行なら待たない', () => {
    expect(backoffSeconds(0)).toBe(0);
    expect(backoffSeconds(-1)).toBe(0);
  });

  it('試行ごとに倍にする', () => {
    expect(backoffSeconds(1)).toBe(BASE_BACKOFF_SECONDS);
    expect(backoffSeconds(2)).toBe(BASE_BACKOFF_SECONDS * 2);
    expect(backoffSeconds(3)).toBe(BASE_BACKOFF_SECONDS * 4);
  });

  it('上限を超えて延ばさない', () => {
    expect(backoffSeconds(100)).toBe(MAX_BACKOFF_SECONDS);
  });
});

describe('isExhausted', () => {
  it('上限に達したら打ち切る', () => {
    expect(isExhausted(MAX_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_ATTEMPTS)).toBe(true);
    expect(isExhausted(MAX_ATTEMPTS + 1)).toBe(true);
  });
});

describe('nextAttemptAt', () => {
  const updatedAt = new Date('2026-08-08T00:00:00Z');

  it('未試行なら即時', () => {
    expect(nextAttemptAt({ updatedAt, attemptCount: 0 })).toEqual(updatedAt);
  });

  it('最後に状態が変わった時刻を基準にする', () => {
    expect(nextAttemptAt({ updatedAt, attemptCount: 1 })).toEqual(
      new Date(updatedAt.getTime() + BASE_BACKOFF_SECONDS * 1000),
    );
  });
});
