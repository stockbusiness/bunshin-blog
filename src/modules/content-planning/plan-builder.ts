/**
 * 構成表の組み立てと再生成ループ（TASKS E-8、SPEC 9.2.6、
 * CONTENT_PLANNING 6）。
 *
 * ```
 * for (retry = 0; retry <= 3; retry++) {
 *   STEP 3 → STEP 4 → 制約チェック → 記録
 *   通れば返す。通らなければ手がかりを持って次へ
 * }
 * 収束しなければ FAILED
 * ```
 *
 * ## 通らない構成表を返さない
 *
 * > 3回で収束しない場合はジョブを `FAILED` とし、ADMINへ通知する。
 * > **暫定的な構成表を承認依頼へ送ってはならない**（SPEC 9.2.6）
 *
 * だから**最後の試行の結果を「まあまあ通った」として返さない。** 例外にする。
 *
 * ## 試行のたびに記録する
 *
 * `planning_runs` に1行ずつ残す。**再生成が何回起きているかが、
 * プロンプト改善の主要な指標**になる（CONTENT_PLANNING 9章）。
 */

import type { AiProvider } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { requireBlogForUser } from '@/modules/blogs';
import {
  buildRepairHints,
  checkConstraints,
  type CheckableItem,
  type ConstraintResult,
} from './constraints';
import { planningNotConvergedError } from './errors';
import { recordPlanRun } from './repository';
import { designRevenueArticlesForUser } from './step3-service';
import { designTrafficArticlesForUser } from './step4-service';
import {
  listPlanItemsWithLinksForUser,
  savePublishOrderForUser,
} from './plan-repository';
import { assignPublishOrder } from './publish-order';

/** 再実行の上限（SPEC 9.2.6「最大3回」） */
export const MAX_PLAN_RETRIES = 3;

export interface BuildPlanInput {
  userId: string;
  blogId: string;
  genreName: string;
  adoptedOfferIds: readonly string[];
}

/** ジョブから渡す入力（`src/app/api/jobs/run/handlers.ts` が組み立てる） */
export type JobPlanInput = BuildPlanInput;

export interface BuildPlanDeps {
  provider?: AiProvider | undefined;
}

export interface BuildPlanAttempt {
  retry: number;
  planId: string;
  result: ConstraintResult;
}

export interface BuildPlanResult {
  planId: string;
  items: CheckableItem[];
  result: ConstraintResult;
  /** 何回目で通ったか（0 なら一発） */
  retries: number;
  attempts: BuildPlanAttempt[];
}

/**
 * 構成表を組み立てる。通るまで最大3回やり直す。
 *
 * **通らなければ例外。** 暫定的な構成表を返さない（SPEC 9.2.6）。
 *
 * @throws {AppError} 3回で収束しなかった・ブログが自分のものでない
 */
export async function buildPlanForUser(
  input: BuildPlanInput,
  deps: BuildPlanDeps = {},
): Promise<BuildPlanResult> {
  const blog = await requireBlogForUser(input);

  const attempts: BuildPlanAttempt[] = [];

  for (let retry = 0; retry <= MAX_PLAN_RETRIES; retry += 1) {
    // **やり直しは作り直し。** 版を増やして作る（前の構成表は残る）
    const revenue = await designRevenueArticlesForUser(
      {
        userId: input.userId,
        blogId: input.blogId,
        adoptedOfferIds: input.adoptedOfferIds,
      },
      deps,
    );

    await designTrafficArticlesForUser(
      {
        userId: input.userId,
        blogId: input.blogId,
        contentPlanId: revenue.planId,
        genreName: input.genreName,
      },
      deps,
    );

    // **公開順序を先に付ける**（E-9）。週の上限は制約チェックの対象で、
    // 未割り当てのまま判定すると必ず通ってしまう
    const drafted = await listPlanItemsWithLinksForUser({
      userId: input.userId,
      blogId: input.blogId,
      contentPlanId: revenue.planId,
    });

    await savePublishOrderForUser({
      userId: input.userId,
      blogId: input.blogId,
      slots: assignPublishOrder({
        items: drafted,
        weeklyCap: blog.articleRatio.weeklyPublishCap,
      }),
    });

    const items = await listPlanItemsWithLinksForUser({
      userId: input.userId,
      blogId: input.blogId,
      contentPlanId: revenue.planId,
    });

    const result = checkConstraints({
      items,
      adoptedOfferCount: input.adoptedOfferIds.length,
    });

    // **通っても通らなくても残す**（再生成の回数が改善の指標になる）
    await recordPlanRun({
      userId: input.userId,
      blogId: input.blogId,
      contentPlanId: revenue.planId,
      retryCount: retry,
      constraintResult: {
        passed: result.passed,
        violations: result.violations.map((entry) => ({
          code: entry.code,
          message: entry.message,
          itemIds: entry.itemIds,
        })),
        counts: result.counts,
      },
      succeeded: result.passed,
      selectedOffers: [...input.adoptedOfferIds],
    });

    attempts.push({ retry, planId: revenue.planId, result });

    if (result.passed) {
      return {
        planId: revenue.planId,
        items,
        result,
        retries: retry,
        attempts,
      };
    }

    logger.warn('構成表が制約を満たさなかった', {
      blogId: input.blogId,
      retry,
      codes: result.violations.map((entry) => entry.code),
      // **手がかりは次の試行で使う。** 全体を作り直させない
      hints: buildRepairHints(result),
    });
  }

  // **暫定的な構成表を返さない**（SPEC 9.2.6）
  throw planningNotConvergedError(
    attempts.at(-1)?.result.violations.map((entry) => entry.code) ?? [],
  );
}
