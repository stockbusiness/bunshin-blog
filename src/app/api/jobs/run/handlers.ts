import { AppError } from '@/lib/errors';
import {
  buildPlanForUser,
  type JobPlanInput,
} from '@/modules/content-planning';
import type { AppJob, JobHandlerRegistry } from '@/modules/jobs';

/**
 * ジョブの種類とハンドラの対応（TASKS E-1、E-9）。
 *
 * **登録は `src/app/` 側で行う**（MODULE_RULES 3）。`jobs` モジュールが
 * ドメインモジュールを import すると `jobs → wordpress → jobs` の
 * 循環になる。
 *
 * **登録されていない種類のジョブは取得されない。** ハンドラが無い種類を
 * 積んでも、`RUNNING` のまま残ることはなく `QUEUED` に留まる。
 *
 * | 種類 | 追加するタスク |
 * |---|---|
 * | `PLAN_GENERATION` | **E-9（登録済み）** |
 * | `WORDPRESS_POST` | F-7（承認からの投稿連携） |
 * | `WORDPRESS_SYNC` | C-5 |
 * | `ARTICLE_GENERATION` | E-10 |
 * | `SEARCH_CONSOLE_FETCH` | G-2 |
 * | `LINE_NOTIFY` | F-2 |
 */

/**
 * ジョブの入力を読む。
 *
 * **`job.input` は jsonb で、何でも入りうる。** 形を確かめてから使う。
 * `user_id` と `blog_id` はジョブの列から取り、入力からは取らない —
 * 入力を信じると、他人のブログの構成表を作れる。
 */
function readPlanInput(job: AppJob): JobPlanInput {
  if (job.userId === null || job.blogId === null) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      'PLAN_GENERATION には user_id と blog_id が要ります',
    );
  }

  const input =
    typeof job.input === 'object' && job.input !== null ? job.input : {};
  const record = input as Record<string, unknown>;
  const genreName = record['genreName'];
  const offerIds = record['adoptedOfferIds'];

  if (typeof genreName !== 'string' || genreName.trim() === '') {
    throw new AppError('BAD_REQUEST', 400, 'genreName が要ります');
  }

  if (
    !Array.isArray(offerIds) ||
    !offerIds.every((id): id is string => typeof id === 'string')
  ) {
    throw new AppError('BAD_REQUEST', 400, 'adoptedOfferIds が要ります');
  }

  return {
    userId: job.userId,
    blogId: job.blogId,
    genreName: genreName.trim(),
    adoptedOfferIds: offerIds,
  };
}

export const JOB_HANDLERS: JobHandlerRegistry = {
  /**
   * 構成表を作る（STEP 3〜4 ＋ 制約チェック ＋ 公開順序）。
   *
   * **3回で収束しなければ例外**になり、ジョブは `FAILED` になる
   * （SPEC 9.2.6）。暫定的な構成表を承認依頼へ送らない。
   */
  PLAN_GENERATION: async (job) => {
    const result = await buildPlanForUser(readPlanInput(job));

    // **戻り値は `output_json` に入る。** 何本作ったかを残す
    return {
      planId: result.planId,
      retries: result.retries,
      counts: result.result.counts,
    };
  },
};
