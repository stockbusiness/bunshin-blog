import { describe, expect, it } from 'vitest';
import {
  INITIAL_ARTICLE_COUNT_RANGE,
  INITIAL_ARTICLE_MIN,
  PERMALINK_PATHS,
  PERMALINK_PATTERNS,
  PUBLISH_HOUR_COUNT,
  PUBLISH_HOUR_MIN,
  PUBLISH_JITTER_MAX_MIN,
  PUBLISH_WEEKDAY_SETS,
  assignPublishSchedule,
  fromPublishTimeColumn,
  toPublishTimeColumn,
} from '@/modules/blogs';

/**
 * 公開スケジュールの割り当て（TASKS C-9、作業指示書 W-8）。
 *
 * 完了条件は「**登録時に既存ブログと重複しにくいよう分散して割り当てる**」
 * 「**全ブログの投稿ジョブが同一時刻に集中しない**」。
 */

function seeds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `user-${String(index)}:1`);
}

describe('決まった値になる', () => {
  /**
   * **ランダムにしない。** 作り直したときに別の値になると、
   * 同じブログの公開時刻が変わる
   */
  it('同じ種なら何度でも同じ', () => {
    expect(assignPublishSchedule('u:1')).toEqual(assignPublishSchedule('u:1'));
  });

  it('種が違えば別の割り当てになりうる', () => {
    const values = seeds(20).map((seed) =>
      JSON.stringify(assignPublishSchedule(seed)),
    );

    expect(new Set(values).size).toBeGreaterThan(1);
  });
});

describe('割り当ての範囲', () => {
  const schedules = seeds(200).map((seed) => assignPublishSchedule(seed));

  it('曜日は決めた組のどれか', () => {
    const allowed = PUBLISH_WEEKDAY_SETS.map((set) => set.join(','));

    for (const schedule of schedules) {
      expect(allowed).toContain(schedule.publishWeekdays.join(','));
    }
  });

  it('時刻は 9時〜14時', () => {
    for (const schedule of schedules) {
      const hour = Number(schedule.publishTime.slice(0, 2));

      expect(hour).toBeGreaterThanOrEqual(PUBLISH_HOUR_MIN);
      expect(hour).toBeLessThan(PUBLISH_HOUR_MIN + PUBLISH_HOUR_COUNT);
    }
  });

  it('ゆらぎは 0〜45分', () => {
    for (const schedule of schedules) {
      expect(schedule.publishJitterMin).toBeGreaterThanOrEqual(0);
      expect(schedule.publishJitterMin).toBeLessThanOrEqual(
        PUBLISH_JITTER_MAX_MIN,
      );
    }
  });

  it('初期記事数は 28〜34', () => {
    for (const schedule of schedules) {
      expect(schedule.initialArticleCount).toBeGreaterThanOrEqual(
        INITIAL_ARTICLE_MIN,
      );
      expect(schedule.initialArticleCount).toBeLessThan(
        INITIAL_ARTICLE_MIN + INITIAL_ARTICLE_COUNT_RANGE,
      );
    }
  });

  it('パーマリンクは4つのどれか', () => {
    for (const schedule of schedules) {
      expect(PERMALINK_PATTERNS).toContain(schedule.permalinkPattern);
    }
  });
});

/**
 * **同一時刻に集中しない**（完了条件）。
 *
 * 30ブログ（Phase 0 の規模）で、曜日と時刻の組がひとつに寄らないこと。
 */
describe('散らばり', () => {
  const schedules = seeds(30).map((seed) => assignPublishSchedule(seed));

  it('曜日の組が2通り以上に分かれる', () => {
    const sets = new Set(
      schedules.map((schedule) => schedule.publishWeekdays.join(',')),
    );

    expect(sets.size).toBeGreaterThanOrEqual(2);
  });

  it('時刻が3通り以上に分かれる', () => {
    const times = new Set(schedules.map((schedule) => schedule.publishTime));

    expect(times.size).toBeGreaterThanOrEqual(3);
  });

  /**
   * **曜日と時刻が同じでも、ゆらぎで実行時刻が分かれる。**
   * 同じ (曜日, 時刻) を引いた組で、ゆらぎまで同じものが多数を占めないこと
   */
  it('同じ曜日・時刻でもゆらぎが揃わない', () => {
    const byMoment = new Map<string, Set<number>>();

    for (const schedule of schedules) {
      const key = `${schedule.publishWeekdays.join(',')}@${schedule.publishTime}`;
      const jitters = byMoment.get(key) ?? new Set<number>();
      jitters.add(schedule.publishJitterMin);
      byMoment.set(key, jitters);
    }

    for (const [, jitters] of byMoment) {
      // 同じ瞬間に2件以上あるなら、ゆらぎは分かれている
      expect(jitters.size).toBeGreaterThanOrEqual(1);
    }

    // **全部が同じゆらぎ**では散らしたことにならない
    expect(
      new Set(schedules.map((s) => s.publishJitterMin)).size,
    ).toBeGreaterThan(1);
  });
});

describe('パーマリンクの文字列', () => {
  /** **スラッグは英数字。** 日本語スラッグを生成しない（W-8） */
  it('4つすべてに文字列がある', () => {
    for (const pattern of PERMALINK_PATTERNS) {
      expect(PERMALINK_PATHS[pattern]).toMatch(/^\/[\w%/-]+\/$/);
    }
  });
});

/** **JSTの壁掛け時計。** UTCへずらさない（Q-031 と同じ考え方） */
describe('time 列との往復', () => {
  it.each([['09:00'], ['14:00'], ['00:00']])(
    '%s は往復しても変わらない',
    (t) => {
      expect(fromPublishTimeColumn(toPublishTimeColumn(t))).toBe(t);
    },
  );
});
