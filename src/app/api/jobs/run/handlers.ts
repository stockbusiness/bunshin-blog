import { AppError } from '@/lib/errors';
import {
  buildPlanForUser,
  type JobPlanInput,
} from '@/modules/content-planning';
import {
  generateArticleForUser,
  readArticleVersionDetailForUser,
} from '@/modules/content-generation';
import { markItemPosted } from '@/modules/content-planning';
import { publishDraftForUser } from '@/modules/wordpress';
import type { AppJob, JobHandlerRegistry } from '@/modules/jobs';
import type {
  WordpressClient,
  WordpressCredentials,
} from '@/modules/wordpress';

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
 * | `WORDPRESS_POST` | **F-7（登録済み）** |
 * | `WORDPRESS_SYNC` | C-5 |
 * | `ARTICLE_GENERATION` | **E-10（登録済み）** |
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

/**
 * 記事生成の入力を読む。
 *
 * **`target_id` に構成表の記事IDを入れる。** 単体生成モードは無いので、
 * 記事IDが無ければ何も生成できない（E-10 の完了条件）。
 */
function readArticleTarget(job: AppJob): {
  userId: string;
  blogId: string;
  contentItemId: string;
} {
  if (job.userId === null || job.blogId === null || job.targetId === null) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      'ARTICLE_GENERATION には user_id・blog_id・target_id が要ります',
    );
  }

  return {
    userId: job.userId,
    blogId: job.blogId,
    contentItemId: job.targetId,
  };
}

/**
 * 投稿の入力を読む。
 *
 * **どの版を投稿するかを入力から取る。** 承認した版を投稿するためで、
 * 最新の版を勝手に拾うと、承認後に作り直された版が承認なしで公開されうる。
 */
function readPostTarget(job: AppJob): {
  userId: string;
  blogId: string;
  contentItemId: string;
  articleVersionId: string;
} {
  if (job.userId === null || job.blogId === null || job.targetId === null) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      'WORDPRESS_POST には user_id・blog_id・target_id が要ります',
    );
  }

  const input =
    typeof job.input === 'object' && job.input !== null ? job.input : {};
  const articleVersionId = (input as Record<string, unknown>)[
    'articleVersionId'
  ];

  if (typeof articleVersionId !== 'string' || articleVersionId === '') {
    throw new AppError('BAD_REQUEST', 400, 'articleVersionId が要ります');
  }

  return {
    userId: job.userId,
    blogId: job.blogId,
    contentItemId: job.targetId,
    articleVersionId,
  };
}

export interface JobHandlerDeps {
  /**
   * WordPress のクライアントを差し替える。
   *
   * **試験のためだけに開ける。** 本番は既定（実HTTP）を使う。
   * 接続情報は `publishDraftForUser` が復号して渡すので、
   * **呼び出し側に接続情報を渡させない**（C-3）。
   */
  wordpressClientFactory?:
    | ((arg: {
        apiBaseUrl: string;
        credentials: WordpressCredentials;
      }) => WordpressClient)
    | undefined;
}

/**
 * ハンドラを組み立てる。
 *
 * **登録の一覧そのものは1箇所**（`JOB_HANDLERS`）。差し替えるのは
 * 外部への呼び出しだけで、ジョブの種類と処理の対応は変えられない。
 */
export function createJobHandlers(
  deps: JobHandlerDeps = {},
): JobHandlerRegistry {
  return {
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

    /**
     * 記事を1本生成する（構成表を参照する。E-10）。
     *
     * **記事は `READY_FOR_REVIEW` にしない。** 事実チェック（E-12）と
     * 禁止表現の検査（E-13）を通っていないため、この時点では
     * 承認依頼へ送れない。
     */
    ARTICLE_GENERATION: async (job) => {
      const version = await generateArticleForUser(readArticleTarget(job));

      return {
        articleVersionId: version.id,
        versionNo: version.versionNo,
        contentHash: version.contentHash,
      };
    },

    /**
     * 承認された記事を下書きとして投稿する（F-7、SPEC 7）。
     *
     * **下書きのまま置く。** 公開はモニターが WordPress 側で行う
     * （SPEC 7「将来、LIFFから公開する場合は2段階承認とする」）。
     *
     * **承認を経ているので `approvedOverwrite` を立てる**（C-5）。
     * 利用者が WordPress 側で直した本文を、承認した内容で上書きしてよい。
     *
     * ジョブは冪等（`idempotency_key` は記事ID）で、投稿そのものも
     * `wordpress_posts` を見て二重投稿しない（C-4）。
     */
    WORDPRESS_POST: async (job) => {
      const target = readPostTarget(job);

      // **承認した版を読む。** 最新の版を拾わない
      const article = await readArticleVersionDetailForUser(target);

      const post = await publishDraftForUser(
        {
          userId: target.userId,
          blogId: target.blogId,
          contentItemId: target.contentItemId,
          approvedOverwrite: true,
        },
        { title: article.title, content: article.bodyHtml },
        deps.wordpressClientFactory,
      );

      // **投稿できてから状態を進める。** 先に進めると、失敗した記事が
      // 「投稿済み」に見える
      await markItemPosted(target.contentItemId);

      return {
        wpPostId: post.wpPostId,
        wpStatus: post.wpStatus,
        articleVersionId: target.articleVersionId,
      };
    },
  };
}

/** 既定の登録。**本番はこれを使う** */
export const JOB_HANDLERS: JobHandlerRegistry = createJobHandlers();
