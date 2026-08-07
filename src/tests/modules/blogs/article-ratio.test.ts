import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  ARTICLE_RATIO_ERROR_CODES,
  DEFAULT_ARTICLE_RATIO,
  WEEKLY_PUBLISH_CAP_MAX,
  parseArticleRatio,
  withWeeklyPublishCap,
  type ArticleRatio,
} from '@/modules/blogs';

/**
 * `blogs.article_ratio` の取り扱い（TASKS B-5）。
 *
 * 押さえたいのは2点。
 * - jsonb は型を保証しないため、壊れた値でも設定画面が開けること
 * - 投稿頻度を変えても **算出値（`revenue` / `traffic`）が消えない**こと（Q-011）
 */

const CURRENT: ArticleRatio = {
  revenue: 9,
  traffic: 21,
  weeklyPublishCap: 2,
};

function catchError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (thrown) {
    return thrown as AppError;
  }

  throw new Error('例外が投げられませんでした');
}

describe('既定値', () => {
  it('SPEC 9.3 の初期30記事・週4本', () => {
    expect(DEFAULT_ARTICLE_RATIO).toEqual({
      revenue: 7,
      traffic: 23,
      weeklyPublishCap: 4,
    });
    expect(DEFAULT_ARTICLE_RATIO.revenue + DEFAULT_ARTICLE_RATIO.traffic).toBe(
      30,
    );
  });

  it('週の上限は4（SPEC 2.2）', () => {
    expect(WEEKLY_PUBLISH_CAP_MAX).toBe(4);
  });
});

describe('parseArticleRatio', () => {
  it('正しい値をそのまま読む', () => {
    expect(parseArticleRatio(CURRENT)).toEqual(CURRENT);
  });

  it.each([null, undefined, 'text', 42, [], true])(
    'オブジェクトでない %s は既定値になる',
    (value) => {
      expect(parseArticleRatio(value)).toEqual(DEFAULT_ARTICLE_RATIO);
    },
  );

  it('欠けた項目だけを既定値で埋める', () => {
    expect(parseArticleRatio({ revenue: 3 })).toEqual({
      revenue: 3,
      traffic: DEFAULT_ARTICLE_RATIO.traffic,
      weeklyPublishCap: DEFAULT_ARTICLE_RATIO.weeklyPublishCap,
    });
  });

  it.each([
    ['文字列', '5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('数値でない %s は既定値で置き換える', (_label, value) => {
    expect(parseArticleRatio({ revenue: value }).revenue).toBe(
      DEFAULT_ARTICLE_RATIO.revenue,
    );
  });

  it('余分なキーを持ち出さない', () => {
    const result = parseArticleRatio({ ...CURRENT, improvementRatio: 0.5 });

    expect(Object.keys(result).sort()).toEqual([
      'revenue',
      'traffic',
      'weeklyPublishCap',
    ]);
  });

  it('例外を投げない（壊れた値でも画面が開ける）', () => {
    expect(() => parseArticleRatio({ revenue: {} })).not.toThrow();
  });
});

describe('withWeeklyPublishCap', () => {
  it.each([1, 2, 3, 4])('週 %s 本を受け入れる', (cap) => {
    expect(withWeeklyPublishCap(CURRENT, cap).weeklyPublishCap).toBe(cap);
  });

  it('算出値を引き継ぐ（Q-011）', () => {
    const result = withWeeklyPublishCap(CURRENT, 4);

    expect(result.revenue).toBe(CURRENT.revenue);
    expect(result.traffic).toBe(CURRENT.traffic);
  });

  it('元の値を書き換えない', () => {
    withWeeklyPublishCap(CURRENT, 4);

    expect(CURRENT.weeklyPublishCap).toBe(2);
  });

  it.each([0, 5, -1, 1.5, Number.NaN])('%s を 422 で拒否する', (cap) => {
    const error = catchError(() => withWeeklyPublishCap(CURRENT, cap));

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(422);
    expect(error.code).toBe(ARTICLE_RATIO_ERROR_CODES.invalidPublishCap);
  });

  it('週5本を拒否する（SPEC 2.2 の上限）', () => {
    const error = catchError(() => withWeeklyPublishCap(CURRENT, 5));

    expect(error.details).toEqual({ requested: 5, max: 4 });
  });
});
