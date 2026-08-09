/**
 * `planning_runs` テーブルへのアクセス（TASKS E-4、SPEC 9.2.2）。
 *
 * **このモジュールだけが `planning_runs` を触る**（MODULE_RULES 1）。
 * `content_plans` と `content_items` も所有するが、書くのは E-6 以降。
 *
 * ## 審査のたびに1行残す
 *
 * 通っても止まっても記録する。**差し戻しの回数を数える根拠**になり、
 * 「なぜこのジャンルで進めたのか」を後から辿れる（SPEC 9.2.2 が
 * 続行の選択を記録するよう定めている）。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireBlogForUser } from '@/modules/blogs';
import type { Step1Decision } from './step1';
import type { AppPlanningRun } from './types';

const SELECT = {
  id: true,
  blogId: true,
  step1Status: true,
  step1Reasons: true,
  rejectionCount: true,
  overriddenAt: true,
  createdAt: true,
} as const;

interface PlanningRunRow {
  id: string;
  blogId: string;
  step1Status: string;
  step1Reasons: Prisma.JsonValue;
  rejectionCount: number;
  overriddenAt: Date | null;
  createdAt: Date;
}

function toAppRun(row: PlanningRunRow): AppPlanningRun {
  return {
    id: row.id,
    blogId: row.blogId,
    step1Status: row.step1Status as AppPlanningRun['step1Status'],
    // jsonb は何でも入りうる。**文字列の配列だけを通す**
    reasons: Array.isArray(row.step1Reasons)
      ? row.step1Reasons.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    rejectionCount: row.rejectionCount,
    overriddenAt: row.overriddenAt,
    createdAt: row.createdAt,
  };
}

/**
 * これまでに何回差し戻されたか。
 *
 * **`BLOCKED` の回数を数える。** 続行を選んだ回（`OVERRIDDEN`）は
 * 差し戻しではないので数えない。
 */
export async function countRejectionsForUser(params: {
  userId: string;
  blogId: string;
}): Promise<number> {
  const blog = await requireBlogForUser(params);

  return prisma.planningRun.count({
    where: { blogId: blog.id, step1Status: 'BLOCKED' },
  });
}

/**
 * 審査の結果を残す。
 *
 * `selected_offers` と `constraint_result` は STEP 1 では決まらないため
 * 空で入れる（NOT NULL）。**STEP 2 以降が同じ行を更新するのではなく、
 * 実行のたびに新しい行を作る** — 何回審査したかが分からなくなる。
 */
export async function recordStep1Run(params: {
  userId: string;
  blogId: string;
  decision: Step1Decision | 'OVERRIDDEN';
  reasons: readonly string[];
  rejectionCount: number;
  overridden: boolean;
}): Promise<AppPlanningRun> {
  const blog = await requireBlogForUser(params);

  const row = await prisma.planningRun.create({
    data: {
      blogId: blog.id,
      step1Status: params.decision,
      step1Reasons: [...params.reasons],
      rejectionCount: params.rejectionCount,
      overriddenAt: params.overridden ? new Date() : null,
      selectedOffers: [],
      constraintResult: {},
    },
    select: SELECT,
  });

  return toAppRun(row);
}

/** ブログの審査履歴を新しい順に返す */
export async function listPlanningRunsForUser(
  params: { userId: string; blogId: string },
  options: { limit?: number | undefined } = {},
): Promise<AppPlanningRun[]> {
  const blog = await requireBlogForUser(params);

  const rows = await prisma.planningRun.findMany({
    where: { blogId: blog.id },
    // `created_at` はミリ秒までしか持たない。同じミリ秒に並ぶと前後が
    // 決まらないので、`id` を最後の決め手にする
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit ?? 50,
    select: SELECT,
  });

  return rows.map(toAppRun);
}

/**
 * 構成表の試行を残す（TASKS E-8）。
 *
 * **通っても通らなくても残す。** 再生成が何回起きているかが、
 * プロンプト改善の主要な指標になる（CONTENT_PLANNING 9章）。
 *
 * STEP 1 の記録（`recordStep1Run`）とは別の行。こちらは
 * `step1_status` に**その時点の審査結果を持たない**ため、
 * 通過を表す `PASSED` を入れる（STEP 2 以降まで来ている＝STEP 1 は通っている）。
 */
export async function recordPlanRun(params: {
  userId: string;
  blogId: string;
  contentPlanId: string;
  retryCount: number;
  constraintResult: Prisma.InputJsonValue;
  selectedOffers: readonly string[];
  succeeded: boolean;
}): Promise<void> {
  const blog = await requireBlogForUser(params);

  await prisma.planningRun.create({
    data: {
      blogId: blog.id,
      contentPlanId: params.contentPlanId,
      step1Status: 'PASSED',
      step1Reasons: [],
      retryCount: params.retryCount,
      constraintResult: params.constraintResult,
      selectedOffers: [...params.selectedOffers],
      succeeded: params.succeeded,
    },
  });
}
