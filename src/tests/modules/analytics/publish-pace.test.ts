import { describe, expect, it } from 'vitest';
import {
  MATURE_AFTER_DAYS,
  MIN_JUDGED_ARTICLES,
  REVIEW_INTERVAL_DAYS,
  isMatureArticle,
  judgePublishPace,
  reviewPeriod,
} from '@/modules/analytics';

/**
 * インデックス率による公開ペースの判定（TASKS G-8b、作業指示書 W-8）。
 *
 * **載っているなら増やしてよく、載らないなら増やしても無駄。**
 */

function judge(overrides: Partial<Parameters<typeof judgePublishPace>[0]>) {
  return judgePublishPace({
    judged: 10,
    indexed: 7,
    currentCap: 4,
    maxCap: 5,
    ...overrides,
  });
}

describe('上限を上げる（80%以上）', () => {
  it('80%ちょうどで上げる', () => {
    expect(judge({ judged: 10, indexed: 8 })).toEqual({
      decision: 'RAISE',
      rate: 0.8,
      nextCap: 5,
    });
  });

  /** 上げられないことは「変えない」であって判定の失敗ではない */
  it('上限に達していれば上げない', () => {
    expect(judge({ judged: 10, indexed: 10, currentCap: 5 })).toMatchObject({
      decision: 'KEEP',
      nextCap: 5,
    });
  });

  it('1段ずつしか上げない', () => {
    expect(judge({ judged: 10, indexed: 10, currentCap: 3 }).nextCap).toBe(4);
  });
});

describe('公開を止める（50%未満）', () => {
  it('50%未満で止める', () => {
    expect(judge({ judged: 10, indexed: 4 })).toEqual({
      decision: 'STOP',
      rate: 0.4,
      nextCap: 0,
    });
  });

  it('50%ちょうどは止めない', () => {
    expect(judge({ judged: 10, indexed: 5 })).toMatchObject({
      decision: 'KEEP',
      nextCap: 4,
    });
  });

  /** **同じ通知が2週間ごとに届き続けるのを避ける** */
  it('既に止まっていれば、もう一度止めない', () => {
    expect(judge({ judged: 10, indexed: 1, currentCap: 0 })).toMatchObject({
      decision: 'KEEP',
      nextCap: 0,
    });
  });
});

describe('変えない（50〜80%）', () => {
  it.each([5, 6, 7])('%s/10 なら変えない', (indexed) => {
    expect(judge({ judged: 10, indexed })).toMatchObject({
      decision: 'KEEP',
      nextCap: 4,
    });
  });
});

/**
 * **測れていないことを「問題なし」にしない。**
 * 1本で 100% や 0% になると、上限が毎回振れる
 */
describe('判定できないとき', () => {
  it('判定のある記事が少なければ動かさない', () => {
    const result = judge({
      judged: MIN_JUDGED_ARTICLES - 1,
      indexed: 0,
      currentCap: 4,
    });

    expect(result).toEqual({
      decision: 'NOT_ENOUGH_DATA',
      // **率を出さない。** 出すと「0%だった」と読める
      rate: null,
      nextCap: 4,
    });
  });

  /** 0本でも例外にしない。**まだ何も公開していないブログは普通にある** */
  it('1本も無くても落ちない', () => {
    expect(judge({ judged: 0, indexed: 0 }).decision).toBe('NOT_ENOUGH_DATA');
  });

  /** 最少本数ちょうどなら判定する */
  it('最少本数ちょうどは判定する', () => {
    expect(judge({ judged: MIN_JUDGED_ARTICLES, indexed: 0 }).decision).toBe(
      'STOP',
    );
  });
});

/**
 * **出したばかりの記事は、まだ載っていなくて当たり前。**
 * 含めると「たくさん出したブログほどインデックス率が低い」ことになる
 */
describe('母数に入れる記事', () => {
  const NOW = new Date('2026-08-12T00:00:00.000Z');

  function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
  }

  it('14日ちょうどなら入れる', () => {
    expect(
      isMatureArticle({ publishedAt: daysAgo(MATURE_AFTER_DAYS), now: NOW }),
    ).toBe(true);
  });

  it('14日未満は入れない', () => {
    expect(
      isMatureArticle({
        publishedAt: daysAgo(MATURE_AFTER_DAYS - 1),
        now: NOW,
      }),
    ).toBe(false);
  });

  /**
   * **下書きのままの記事が載っていないのは当たり前。**
   * Phase 0 で作るのは下書きで、公開はモニターが WordPress 側で行う
   */
  it('公開していない記事は入れない', () => {
    expect(isMatureArticle({ publishedAt: null, now: NOW })).toBe(false);
  });
});

/**
 * **間隔を冪等キーに持たせる**（G-8b）。cron が毎分呼んでも、
 * 同じ回のジョブは1件しか積まれない（C-4）。
 *
 * **区切りは基準時刻（1970-01-01）から数えた14日ごと**で、
 * 「最初に動かした日から14日」ではない。初回だけ間隔が短くなりうるが、
 * **呼ぶ側が前回の時刻を覚えなくてよい**ほうを取る
 */
describe('見直しの回', () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const INTERVAL = REVIEW_INTERVAL_DAYS * DAY;

  /** ある回の始まりの瞬間 */
  function periodStart(at: Date): Date {
    return new Date(reviewPeriod(at) * INTERVAL);
  }

  const START = periodStart(new Date('2026-08-12T00:00:00.000Z'));

  it('同じ回のうちは同じ番号', () => {
    expect(reviewPeriod(new Date(START.getTime() + INTERVAL - 1))).toBe(
      reviewPeriod(START),
    );
  });

  it('区切りを跨げば番号が1つ進む', () => {
    expect(reviewPeriod(new Date(START.getTime() + INTERVAL))).toBe(
      reviewPeriod(START) + 1,
    );
  });
});
