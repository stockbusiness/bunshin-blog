/**
 * `ai_usage_logs` テーブルへのアクセス（TASKS E-14、SPEC 12.1）。
 *
 * **このモジュールだけが `ai_usage_logs` を触る**（MODULE_RULES 1）。
 *
 * ## 記録は落とさない
 *
 * **単価が未設定でも記録する。** 費用が0で入るだけで、トークン数は残る。
 * 記録そのものを飛ばすと、後から単価を入れても**何回呼んだかすら
 * 分からなくなる**。
 *
 * 「費用を計算できなかった呼び出し」は集計で数えて返す（`unpricedCalls`）。
 * 0円の合計を見て「安く済んでいる」と誤解しないため。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger, type Logger } from '@/lib/logger';
import { getMailer, type Mailer } from '@/lib/mailer';
import { getRuntimeEnv } from '@/modules/settings';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import {
  buildBudgetAlert,
  crossedThresholds,
  readBudgetLimits,
  type BudgetCrossing,
} from './budget';
import { invalidUsageError } from './errors';
import type {
  AiCostSummary,
  AppAiUsageLog,
  CostPeriod,
  RecordAiUsageInput,
} from './types';

const SELECT = {
  id: true,
  userId: true,
  blogId: true,
  contentItemId: true,
  jobId: true,
  provider: true,
  model: true,
  operation: true,
  inputTokens: true,
  outputTokens: true,
  webSearchCalls: true,
  costUsd: true,
  createdAt: true,
} as const;

interface UsageRow {
  id: string;
  userId: string;
  blogId: string | null;
  contentItemId: string | null;
  jobId: string | null;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  costUsd: Prisma.Decimal;
  createdAt: Date;
}

function toAppLog(row: UsageRow): AppAiUsageLog {
  return {
    ...row,
    // **`Decimal` のまま外へ出さない。** 呼び出し側が計算で取り違える
    costUsd: row.costUsd.toNumber(),
  };
}

function assertTokens(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidUsageError(`${label}は0以上の整数で指定してください`);
  }

  return value;
}

/**
 * 1回の呼び出しを記録する（完了条件）。
 *
 * **費用は小数6桁で保存する**（`decimal(10,6)`）。1回あたりの費用は
 * 0.001ドルを下回ることがあり、丸めると積み上げが合わなくなる。
 */
export async function recordAiUsage(
  input: RecordAiUsageInput,
): Promise<AppAiUsageLog> {
  const costUsd = input.costUsd ?? null;

  if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
    throw invalidUsageError('費用は0以上で指定してください');
  }

  const row = await prisma.aiUsageLog.create({
    data: {
      userId: input.userId,
      blogId: input.blogId ?? null,
      contentItemId: input.contentItemId ?? null,
      jobId: input.jobId ?? null,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      inputTokens: assertTokens(input.inputTokens, '入力トークン'),
      outputTokens: assertTokens(input.outputTokens, '出力トークン'),
      webSearchCalls: assertTokens(input.webSearchCalls ?? 0, 'Web検索の回数'),
      // **単価が無くても記録は残す。** 0で入れ、集計側で件数を数える
      costUsd: new Prisma.Decimal(costUsd ?? 0),
    },
    select: SELECT,
  });

  return toAppLog(row);
}

/** 期間の条件を作る。両端を含む扱いにしない（`to` は含まない） */
function periodWhere(period?: CostPeriod): Prisma.AiUsageLogWhereInput {
  return period === undefined
    ? {}
    : { createdAt: { gte: period.from, lt: period.to } };
}

/**
 * 生の記録を集計する。
 *
 * **`costUsd = 0` を「単価未設定」とみなす。** 実際に0円の呼び出しは
 * 起きないため（トークンを使えば必ず費用が出る）、この近似で足りる。
 * 厳密に分けるには専用の列が要るが、スキーマを増やすほどの精度ではない。
 */
function summarize(
  rows: {
    key: string | null;
    costUsd: Prisma.Decimal;
    inputTokens: number;
    outputTokens: number;
  }[],
): AiCostSummary[] {
  const buckets = new Map<string, AiCostSummary>();

  for (const row of rows) {
    const key = row.key ?? '';
    const current = buckets.get(key) ?? {
      key,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      unpricedCalls: 0,
    };

    const cost = row.costUsd.toNumber();

    buckets.set(key, {
      key,
      costUsd: current.costUsd + cost,
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      calls: current.calls + 1,
      unpricedCalls: current.unpricedCalls + (cost === 0 ? 1 : 0),
    });
  }

  return [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * 自分の費用を集計する。
 *
 * `groupBy` で切り口を変える（完了条件「ユーザー別・ブログ別・記事別・
 * モデル別」）。**ユーザー別はこの関数では出ない** — 自分の分しか見ないため。
 * 横断は `summarizeByUserForAdmin`。
 */
export async function summarizeCostForUser(
  userId: string,
  options: {
    groupBy: 'blog' | 'contentItem' | 'model' | 'operation';
    period?: CostPeriod | undefined;
  },
): Promise<AiCostSummary[]> {
  const rows = await prisma.aiUsageLog.findMany({
    where: { userId, ...periodWhere(options.period) },
    select: {
      blogId: true,
      contentItemId: true,
      model: true,
      operation: true,
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
    },
  });

  return summarize(
    rows.map((row) => ({
      key:
        options.groupBy === 'blog'
          ? row.blogId
          : options.groupBy === 'contentItem'
            ? row.contentItemId
            : options.groupBy === 'model'
              ? row.model
              : row.operation,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    })),
  );
}

/** 自分の合計費用（USD）。予算の判定（E-15）が使う */
export async function totalCostForUser(
  userId: string,
  period?: CostPeriod,
): Promise<number> {
  const result = await prisma.aiUsageLog.aggregate({
    where: { userId, ...periodWhere(period) },
    _sum: { costUsd: true },
  });

  return result._sum.costUsd?.toNumber() ?? 0;
}

/**
 * ブログの合計費用（USD）。
 *
 * **所有権を確かめる**（SPEC 14.1）。他人のブログの費用は見えない。
 *
 * **名前を `...ForUser` で終える。** 所有権を伴う入口はこの形に揃える
 * 決まりで、C-6 の網羅チェックもこの名前で拾う。`totalCostForBlog` の
 * ような名前にすると、**越境テストの対象から静かに漏れる**。
 */
export async function totalBlogCostForUser(
  params: { userId: string; blogId: string },
  period?: CostPeriod,
): Promise<number> {
  const blog = await requireBlogForUser(params);

  const result = await prisma.aiUsageLog.aggregate({
    where: { blogId: blog.id, ...periodWhere(period) },
    _sum: { costUsd: true },
  });

  return result._sum.costUsd?.toNumber() ?? 0;
}

/**
 * 記事1本の費用（USD）。
 *
 * **ブログ経由で所有権を確かめる。** `content_item_id` だけで引くと、
 * 他人の記事の費用が見える（C-6 で見つけたのと同じ形）。
 */
export async function totalContentItemCostForUser(params: {
  userId: string;
  blogId: string;
  contentItemId: string;
}): Promise<number> {
  const blog = await requireBlogForUser(params);

  const result = await prisma.aiUsageLog.aggregate({
    where: { blogId: blog.id, contentItemId: params.contentItemId },
    _sum: { costUsd: true },
  });

  if (result._sum.costUsd === null) {
    // 記録が1件も無い。記事が無いのか、まだ生成していないのか区別しない
    return 0;
  }

  return result._sum.costUsd.toNumber();
}

/** 自分の記録を新しい順に返す */
export async function listAiUsageForUser(
  userId: string,
  options: { period?: CostPeriod | undefined; limit?: number | undefined } = {},
): Promise<AppAiUsageLog[]> {
  const rows = await prisma.aiUsageLog.findMany({
    where: { userId, ...periodWhere(options.period) },
    // **`created_at` はミリ秒までしか持たない。** 同じミリ秒の記録が並ぶと
    // 前後が決まらず、`take` の切れ目でどちらが落ちるかが呼ぶたびに変わる。
    // `id` を最後の決め手にして、少なくとも同じ結果が返るようにする
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit ?? 200,
    select: SELECT,
  });

  return rows.map(toAppLog);
}

/**
 * 全ユーザーの費用を集計する（ADMIN 用・SPEC 12.1）。
 *
 * **横断参照であることが分かる名前にする**（MODULE_RULES 5）。
 * 呼び出し側で `requireAdmin` を通すこと。
 */
export async function summarizeByUserForAdmin(
  period?: CostPeriod,
): Promise<AiCostSummary[]> {
  const rows = await prisma.aiUsageLog.findMany({
    where: periodWhere(period),
    select: {
      userId: true,
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
    },
  });

  return summarize(
    rows.map((row) => ({
      key: row.userId,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    })),
  );
}

/** 記録を1件引く（ADMIN の調査用） */
export async function findAiUsageForAdmin(id: string): Promise<AppAiUsageLog> {
  const row = await prisma.aiUsageLog.findUnique({
    where: { id },
    select: SELECT,
  });

  if (row === null) {
    throw notFoundError('AI利用記録');
  }

  return toAppLog(row);
}

/**
 * 予算の境目を跨いだかを見て、跨いでいれば ADMIN へ通知する（E-15）。
 *
 * **記録の直後に呼ぶ。** `costBeforeUsd` は記録する前の合計。
 *
 * **通知の失敗で生成を止めない。** 予算の通知は運用の助けであって、
 * 記事が出るかどうかとは関係が無い。失敗はログに残す。
 *
 * **生成の可否は返さない**（SPEC 12.2「予算超過時も生成を停止しない」）。
 * 止める仕組みは `shouldStopGeneration` にあり、既定では常に `false`。
 */
export async function notifyBudgetCrossings(params: {
  crossings: readonly BudgetCrossing[];
  deps?: {
    mailer?: Mailer | undefined;
    env?: Readonly<Record<string, string | undefined>> | undefined;
    logger?: Logger | undefined;
  };
}): Promise<number> {
  if (params.crossings.length === 0) {
    return 0;
  }

  // **`process.env` を直接見ない**（H-10）。管理画面で設定した
  // 宛先と鍵を使う
  const env = params.deps?.env ?? (await getRuntimeEnv());
  const log = params.deps?.logger ?? logger;
  const to = (env['ADMIN_ALERT_EMAIL'] ?? '').trim();

  if (to === '') {
    // **宛先が無いだけで落とさない。** 通知は運用の助けで、記事の生成とは別
    log.warn('ADMIN_ALERT_EMAIL が未設定のため予算通知を送れない', {
      count: params.crossings.length,
    });

    return 0;
  }

  const mailer = params.deps?.mailer ?? getMailer({ ...env });
  let sent = 0;

  for (const crossing of params.crossings) {
    const message = buildBudgetAlert(crossing);

    try {
      await mailer.send({ to, ...message });
      sent += 1;
    } catch (error) {
      log.error('予算通知を送れなかった', {
        scope: crossing.scope,
        threshold: crossing.threshold,
        cause: error,
      });
    }
  }

  return sent;
}

/**
 * 記録して、予算の境目を跨いでいれば通知する（E-14 + E-15 の入口）。
 *
 * 記事生成（E-10）はこれを呼ぶ。**合計を先に読むのは、跨いだかを
 * 判定するため。**
 */
export async function recordAiUsageAndNotify(
  input: RecordAiUsageInput,
  deps?: {
    mailer?: Mailer | undefined;
    env?: Readonly<Record<string, string | undefined>> | undefined;
    logger?: Logger | undefined;
    period?: CostPeriod | undefined;
  },
): Promise<{ log: AppAiUsageLog; crossings: BudgetCrossing[] }> {
  // **`process.env` を直接見ない**（H-10）。管理画面で設定した予算を使う
  const env = deps?.env ?? (await getRuntimeEnv());
  const limits = readBudgetLimits(env);
  const period = deps?.period;

  const userBefore = await totalCostForUser(input.userId, period);
  const blogBefore =
    input.blogId === undefined || input.blogId === null
      ? null
      : await rawBlogCost(input.blogId, period);

  const log = await recordAiUsage(input);

  const userAfter = await totalCostForUser(input.userId, period);
  const crossings = crossedThresholds({
    scope: 'USER',
    limitUsd: limits.userMonthlyUsd,
    costBeforeUsd: userBefore,
    costAfterUsd: userAfter,
  });

  if (
    blogBefore !== null &&
    input.blogId !== undefined &&
    input.blogId !== null
  ) {
    const blogAfter = await rawBlogCost(input.blogId, period);

    crossings.push(
      ...crossedThresholds({
        scope: 'BLOG',
        limitUsd: limits.blogMonthlyUsd,
        costBeforeUsd: blogBefore,
        costAfterUsd: blogAfter,
      }),
    );
  }

  // **解決済みの設定をそのまま渡す。** 通知側でもう一度読むと、
  // その間に設定が変わったときに予算の判定と宛先がずれる
  await notifyBudgetCrossings({ crossings, deps: { ...deps, env } });

  return { log, crossings };
}

/**
 * 所有権を確かめずにブログの費用を合計する。
 *
 * **記録を書く側からしか呼ばない。** 呼び出し元は既にそのブログのために
 * AIを動かしており、所有権は上流で確かめられている。外へは公開しない
 * （`index.ts` に出さない）。
 */
async function rawBlogCost(
  blogId: string,
  period?: CostPeriod,
): Promise<number> {
  const result = await prisma.aiUsageLog.aggregate({
    where: { blogId, ...periodWhere(period) },
    _sum: { costUsd: true },
  });

  return result._sum.costUsd?.toNumber() ?? 0;
}
