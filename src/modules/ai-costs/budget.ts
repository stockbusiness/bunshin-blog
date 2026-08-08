/**
 * 予算の判定（TASKS E-15、SPEC 12.2）。
 *
 * ## 止めない
 *
 * > Phase 0では予算超過時も生成を停止しない。検証期間中に停止すると
 * > データが欠落し、Phase 0の目的を損なうためである（SPEC 12.2）
 *
 * **これが完了条件の半分。** 判定は「通知するかどうか」だけを決め、
 * 生成の可否には関わらない。
 *
 * 停止と低価格モデルへの切替は**仕組みだけ用意し、既定を無効にする**
 * （SPEC 12.2）。有効にするのは ADMIN の明示的な操作。
 *
 * ## 通知は「跨いだとき」に出す
 *
 * 80%を超えている間ずっと鳴らすと、AI呼び出しのたびにメールが飛ぶ。
 * **記録の前と後で境目を跨いだかを見る。** 状態を持たずに一度きりにできる。
 *
 * ```
 * 前 78% → 後 82%   80%を跨いだ → 通知
 * 前 82% → 後 85%   跨いでいない → 通知しない
 * 前 95% → 後 160%  100%と150%を跨いだ → 2つとも通知
 * ```
 *
 * DBを触らない純粋な処理。
 */

/** 通知する境目（SPEC 12.2「予算80%・100%・150%」） */
export const BUDGET_THRESHOLDS = [0.8, 1.0, 1.5] as const;

export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

/** 予算の適用先 */
export type BudgetScope = 'USER' | 'BLOG';

export interface BudgetCrossing {
  scope: BudgetScope;
  /** 跨いだ割合（0.8 / 1.0 / 1.5） */
  threshold: BudgetThreshold;
  limitUsd: number;
  costUsd: number;
}

/**
 * 境目を跨いだかを見る。
 *
 * **`before` を含めない、`after` を含める。** 同じ額で2回呼ばれても
 * 2回目は跨がない。
 */
export function crossedThresholds(params: {
  scope: BudgetScope;
  limitUsd: number | null;
  costBeforeUsd: number;
  costAfterUsd: number;
}): BudgetCrossing[] {
  const { limitUsd } = params;

  // 上限が設定されていなければ何も鳴らさない。**0を上限として扱わない**
  // （0だと最初の1回で全ての境目を跨ぐ）
  if (limitUsd === null || limitUsd <= 0) {
    return [];
  }

  return BUDGET_THRESHOLDS.filter((threshold) => {
    const line = limitUsd * threshold;

    return params.costBeforeUsd < line && params.costAfterUsd >= line;
  }).map((threshold) => ({
    scope: params.scope,
    threshold,
    limitUsd,
    costUsd: params.costAfterUsd,
  }));
}

export interface BudgetLimits {
  /** ユーザー1人あたりの月間上限（USD）。未設定なら `null` */
  userMonthlyUsd: number | null;
  /** ブログ1つあたりの月間上限（USD）。未設定なら `null` */
  blogMonthlyUsd: number | null;
  /**
   * 予算超過で生成を止めるか。
   *
   * **既定は `false`**（SPEC 12.2）。Phase 0 で止めるとデータが欠落する。
   * 有効にするのは ADMIN の明示的な操作。
   */
  stopOnExceeded: boolean;
  /**
   * 予算超過で低価格モデルへ切り替えるか。
   *
   * **既定は `false`**（SPEC 12.2）。同上。
   */
  downgradeOnExceeded: boolean;
}

function readNumber(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): number | null {
  const raw = env[key];

  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);

  return Number.isFinite(value) && value > 0 ? value : null;
}

function readFlag(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean {
  // **`true` だけを有効とみなす。** 曖昧な値で止まると原因が分かりにくい
  return (env[key] ?? '').trim().toLowerCase() === 'true';
}

/**
 * 予算の設定を読む。
 *
 * **環境変数から読む。** Phase 0 は10名で上限も一律の想定（SPEC 12.3）で、
 * 利用者ごとに変える段階ではない。個別の上限が要るようになったら
 * テーブルへ移す。
 */
export function readBudgetLimits(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BudgetLimits {
  return {
    userMonthlyUsd: readNumber(env, 'AI_BUDGET_USER_MONTHLY_USD'),
    blogMonthlyUsd: readNumber(env, 'AI_BUDGET_BLOG_MONTHLY_USD'),
    stopOnExceeded: readFlag(env, 'AI_BUDGET_STOP_ON_EXCEEDED'),
    downgradeOnExceeded: readFlag(env, 'AI_BUDGET_DOWNGRADE_ON_EXCEEDED'),
  };
}

/**
 * 生成を止めるべきか（**既定では常に `false`**）。
 *
 * SPEC 12.2 が「停止機能は実装するが既定値を無効とする」と定めているため、
 * 判定そのものは用意しておく。**呼び出し側はこの結果を見て止める**が、
 * `AI_BUDGET_STOP_ON_EXCEEDED=true` にしない限り `false` のまま。
 */
export function shouldStopGeneration(params: {
  limits: BudgetLimits;
  costUsd: number;
}): boolean {
  if (!params.limits.stopOnExceeded) {
    return false;
  }

  const limit = params.limits.userMonthlyUsd;

  return limit !== null && limit > 0 && params.costUsd >= limit;
}

/**
 * 低価格モデルへ落とすべきか（**既定では常に `false`**）。
 *
 * SPEC 12.2。停止と同じく仕組みだけ用意する。
 */
export function shouldDowngradeModel(params: {
  limits: BudgetLimits;
  costUsd: number;
}): boolean {
  if (!params.limits.downgradeOnExceeded) {
    return false;
  }

  const limit = params.limits.userMonthlyUsd;

  return limit !== null && limit > 0 && params.costUsd >= limit;
}

/** 通知の本文（ADMIN 宛て） */
export function buildBudgetAlert(crossing: BudgetCrossing): {
  subject: string;
  text: string;
} {
  const percent = Math.round(crossing.threshold * 100);
  const scope = crossing.scope === 'USER' ? 'ユーザー' : 'ブログ';

  return {
    subject: `[BUNSHIN BLOG] AI費用が${scope}の月間予算の${percent}%に達しました`,
    text: [
      `${scope}の月間AI費用が予算の${percent}%に達しました。`,
      '',
      `予算: $${crossing.limitUsd.toFixed(2)}`,
      `現在: $${crossing.costUsd.toFixed(4)}`,
      '',
      // **止まっていないことを明記する。** 受け取った側が「生成が
      // 止まった」と誤解して対応を急ぐのを防ぐ（SPEC 12.2）
      'Phase 0 では予算を超えても記事の生成は停止しません。',
      '検証期間中に停止するとデータが欠落するためです。',
    ].join('\n'),
  };
}
