import { AppError } from '@/lib/errors';

/**
 * `blogs.article_ratio`（jsonb）の取り扱い（B-5）。
 *
 * DATA_MODEL 3章の定義:
 *
 * ```ts
 * {
 *   revenue: number;          // 収益記事の本数（9.2.4の算出値）
 *   traffic: number;          // 集客記事の本数
 *   weeklyPublishCap: number; // 既定 4、範囲 3〜5（SPEC 2.2・Q-036）
 * }
 * ```
 *
 * **`revenue` と `traffic` は利用者に編集させない**（OPEN_QUESTIONS Q-011）。
 * SPEC 9.2.4 の算出値であり、編集させると SPEC 9.2「判定は必ずコード側で行う」
 * に反する。設定画面から変えられるのは `weeklyPublishCap` のみ。
 */

export interface ArticleRatio {
  revenue: number;
  traffic: number;
  weeklyPublishCap: number;
}

/**
 * 週の公開上限の範囲（SPEC 2.2。2026-08-12 に週4本固定から改めた・Q-036）。
 *
 * 「週5本を超えて公開する処理を実装してはならない」。
 *
 * **下限は3本。** 更新が途切れたブログは評価が落ちるため、
 * 通常運転の下限として3本を置く。
 *
 * **0本はここに含めない。** インデックス率が50%未満のときに公開を止める
 * （G-8）**異常時の停止**であって、利用者が選べる設定ではない。
 * 同じ検証を共用すると**画面から0本にでき、止まっているのが異常なのか
 * 設定なのか区別できなくなる。**
 */
export const WEEKLY_PUBLISH_CAP_MAX = 5;
export const WEEKLY_PUBLISH_CAP_MIN = 3;

/**
 * 新規作成時の既定値（SPEC 2.2「既定は週4本」・9.3 の初期30記事）。
 *
 * **上限と同じ値にしない。** 上限を5へ広げたのは G-8 が実測で
 * 上げるためで、**最初から5本で始めるためではない**
 */
export const DEFAULT_WEEKLY_PUBLISH_CAP = 4;

export const DEFAULT_ARTICLE_RATIO: ArticleRatio = {
  revenue: 7,
  traffic: 23,
  weeklyPublishCap: DEFAULT_WEEKLY_PUBLISH_CAP,
};

export const ARTICLE_RATIO_ERROR_CODES = {
  invalidPublishCap: 'BLOG_PUBLISH_CAP_INVALID',
} as const;

function toCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * jsonb の値を `ArticleRatio` として読む。
 *
 * **壊れた値でも例外を投げない。** jsonb は型を保証しないため、
 * 想定外の形が入っていても設定画面が開けなくなるのは避ける。
 * 欠けている項目は既定値で埋める。
 */
export function parseArticleRatio(value: unknown): ArticleRatio {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_ARTICLE_RATIO };
  }

  const source = value as Record<string, unknown>;

  return {
    revenue: toCount(source['revenue'], DEFAULT_ARTICLE_RATIO.revenue),
    traffic: toCount(source['traffic'], DEFAULT_ARTICLE_RATIO.traffic),
    weeklyPublishCap: toCount(
      source['weeklyPublishCap'],
      DEFAULT_ARTICLE_RATIO.weeklyPublishCap,
    ),
  };
}

/** 週の公開上限が不正 */
export function invalidPublishCapError(requested: number): AppError {
  return new AppError(
    ARTICLE_RATIO_ERROR_CODES.invalidPublishCap,
    422,
    `投稿頻度は週${String(WEEKLY_PUBLISH_CAP_MIN)}〜${String(WEEKLY_PUBLISH_CAP_MAX)}本で指定してください`,
    { details: { requested, max: WEEKLY_PUBLISH_CAP_MAX } },
  );
}

/**
 * 週の公開上限だけを差し替える。
 *
 * **`revenue` と `traffic` はそのまま引き継ぐ**（Q-011）。上限だけを
 * 受け取って全体を組み立て直すと、算出値が既定値で上書きされる。
 *
 * @throws {AppError} 3〜5 以外（422）。**0は通さない** —
 *   公開の停止は G-8 の異常時の処理で、設定画面から選ぶものではない
 */
export function withWeeklyPublishCap(
  current: ArticleRatio,
  weeklyPublishCap: number,
): ArticleRatio {
  if (
    !Number.isInteger(weeklyPublishCap) ||
    weeklyPublishCap < WEEKLY_PUBLISH_CAP_MIN ||
    weeklyPublishCap > WEEKLY_PUBLISH_CAP_MAX
  ) {
    throw invalidPublishCapError(weeklyPublishCap);
  }

  return { ...current, weeklyPublishCap };
}

/**
 * 見直しの結果を入れる（G-8b）。**利用者の入力には使わない。**
 *
 * `withWeeklyPublishCap` と分けているのは、**0本を通す唯一の経路**を
 * ここに閉じるため。同じ検証を共用すると**画面から0本にでき、
 * 止まっているのが異常なのか設定なのか区別できなくなる。**
 *
 * 0 と 3〜5 だけを通す。**1・2 は通さない** — 利用者も選べず、
 * 見直しも作らない値で、入ってきたなら呼ぶ側が誤っている。
 *
 * @throws {AppError} 0・3〜5 以外（422）
 */
export function withAdjustedPublishCap(
  current: ArticleRatio,
  weeklyPublishCap: number,
): ArticleRatio {
  const allowed =
    weeklyPublishCap === 0 ||
    (Number.isInteger(weeklyPublishCap) &&
      weeklyPublishCap >= WEEKLY_PUBLISH_CAP_MIN &&
      weeklyPublishCap <= WEEKLY_PUBLISH_CAP_MAX);

  if (!allowed) {
    throw invalidPublishCapError(weeklyPublishCap);
  }

  return { ...current, weeklyPublishCap };
}
