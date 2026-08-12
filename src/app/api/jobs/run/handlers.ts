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
import {
  aggregateDailyMetricsForUser,
  fetchIndexStatusForUser,
  fetchSearchMetricsForUser,
} from '@/modules/analytics';
import {
  enqueueAlertsForUser,
  recordLineReplyForUser,
  sendEmergencyNotificationForUser,
  type EmergencyKind,
} from '@/modules/line';
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
 * | `LINK_CHECK` | **H-3（登録済み）** |
 * | `ARTICLE_GENERATION` | **E-10（登録済み）** |
 * | `SEARCH_CONSOLE_FETCH` | **G-2（登録済み）** |
 * | `URL_INSPECTION` | **G-3（登録済み）** |
 * | `METRICS_AGGREGATE` | **G-6（登録済み）** |
 * | `LINE_NOTIFY` | **H-3（登録済み）** |
 * | `LINE_REPLY` | **D-7b（登録済み）** |
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

/**
 * 緊急通知の入力を読む。
 *
 * **`job.input` は jsonb で、何でも入りうる。** 形を確かめてから使う。
 */
function readAlertInput(job: AppJob): {
  userId: string;
  kind: EmergencyKind;
  blogName: string;
  detail: string;
} {
  if (job.userId === null) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      'LINE_NOTIFY には user_id が要ります',
    );
  }

  const input =
    typeof job.input === 'object' && job.input !== null ? job.input : {};
  const record = input as Record<string, unknown>;
  const kind = record['kind'];

  if (
    kind !== 'LINK_BROKEN' &&
    kind !== 'OFFER_ENDED' &&
    kind !== 'WORDPRESS_DISCONNECTED'
  ) {
    throw new AppError('BAD_REQUEST', 400, 'kind が要ります');
  }

  return {
    userId: job.userId,
    kind,
    blogName: typeof record['blogName'] === 'string' ? record['blogName'] : '',
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
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
 * LINE返信の入力を読む。
 *
 * **`user_id` はジョブの列から取り、入力からは取らない。** 入力を信じると、
 * 他人の分身に記憶を書き込める（`readPlanInput` と同じ判断）。
 */
function readReplyInput(job: AppJob): {
  userId: string;
  text: string;
  eventId: string;
} {
  if (job.userId === null) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      'LINE_REPLY には user_id が要ります',
    );
  }

  const input =
    typeof job.input === 'object' && job.input !== null ? job.input : {};
  const record = input as Record<string, unknown>;
  const text = record['text'];
  const eventId = record['eventId'];

  if (typeof text !== 'string' || typeof eventId !== 'string') {
    throw new AppError('BAD_REQUEST', 400, 'text と eventId が要ります');
  }

  return { userId: job.userId, text, eventId };
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

    /**
     * リンク切れ・接続切れ・案件終了を見て、通知を積む（H-3）。
     *
     * **その場で送らない。** 検出はブログごとにHTTPを叩くため時間がかかり、
     * 途中で落ちると「一部だけ送った」状態になる。積んでおけば
     * 送信の失敗は再試行される（C-4）。
     */
    LINK_CHECK: async (job) => {
      if (job.userId === null) {
        throw new AppError(
          'BAD_REQUEST',
          400,
          'LINK_CHECK には user_id が要ります',
        );
      }

      const queued = await enqueueAlertsForUser(job.userId);

      return { queued };
    },

    /**
     * 緊急通知を送る（H-3、SPEC 8.3）。
     *
     * **提案の1日の件数を消費しない**（F-3）。`approvals` の行を作らないので、
     * 数えようがない。
     */
    LINE_NOTIFY: async (job) => {
      const input = readAlertInput(job);

      await sendEmergencyNotificationForUser(input.userId, {
        kind: input.kind,
        blogName: input.blogName,
        detail: input.detail,
      });

      return { kind: input.kind };
    },

    /**
     * LINE返信を取り込む（D-7b、SPEC 8.4）。
     *
     * **Webhook のハンドラで直接処理しない。** 保存に時間がかかると
     * LINE 側が時間切れと見なして**同じ電文を再送**する。
     *
     * **返信の本文は `job.input` に入っている。** 分類も保存も
     * `line` モジュールが行い、ここは形を確かめて渡すだけ。
     */
    LINE_REPLY: async (job) => {
      const input = readReplyInput(job);

      const result = await recordLineReplyForUser({
        userId: input.userId,
        text: input.text,
        eventId: input.eventId,
      });

      // **返信の本文は残さない**（`output_json` は管理画面に出る。SPEC 14.2）
      return {
        kind: result.kind,
        outcome: result.outcome,
        guided: result.guided,
      };
    },

    /**
     * Search Console の実績を取り込む（G-2、SPEC 11.3）。
     *
     * **直近数日を毎回取り直す。** Search Console のデータは遅れて
     * 確定するため、昨日ぶんだけ取ると取りこぼしたまま二度と取り直さない。
     *
     * **未連携・読めない状態のブログは `null` が返る。** 失敗ではないので
     * ジョブは成功として終える — 再試行しても状況は変わらない。
     */
    SEARCH_CONSOLE_FETCH: async (job) => {
      if (job.userId === null || job.blogId === null) {
        throw new AppError(
          'BAD_REQUEST',
          400,
          'SEARCH_CONSOLE_FETCH には user_id と blog_id が要ります',
        );
      }

      const summary = await fetchSearchMetricsForUser({
        userId: job.userId,
        blogId: job.blogId,
      });

      return summary === null ? { skipped: true } : { ...summary };
    },

    /**
     * インデックス状況を調べる（G-3、SPEC 11.3「URL Inspectionは別ジョブ」）。
     *
     * **`SEARCH_CONSOLE_FETCH` と分ける。** 呼び出しの上限の枠が別で、
     * こちらは記事の本数だけ呼ぶ。同じジョブにすると、上限に当たったときに
     * 取れていたはずの検索データまで巻き戻る。
     */
    URL_INSPECTION: async (job) => {
      if (job.userId === null || job.blogId === null) {
        throw new AppError(
          'BAD_REQUEST',
          400,
          'URL_INSPECTION には user_id と blog_id が要ります',
        );
      }

      const summary = await fetchIndexStatusForUser({
        userId: job.userId,
        blogId: job.blogId,
      });

      return summary === null ? { skipped: true } : { ...summary };
    },

    /**
     * クリックを日ごとに数え直す（G-6、SPEC 10.2）。
     *
     * **外部に依存しない。** Google が落ちていても数えられるので、
     * 検索データの取得（G-2）とは別のジョブにする。
     */
    METRICS_AGGREGATE: async (job) => {
      if (job.userId === null || job.blogId === null) {
        throw new AppError(
          'BAD_REQUEST',
          400,
          'METRICS_AGGREGATE には user_id と blog_id が要ります',
        );
      }

      const summary = await aggregateDailyMetricsForUser({
        userId: job.userId,
        blogId: job.blogId,
      });

      return { ...summary, dates: [...summary.dates] };
    },
  };
}

/** 既定の登録。**本番はこれを使う** */
export const JOB_HANDLERS: JobHandlerRegistry = createJobHandlers();
