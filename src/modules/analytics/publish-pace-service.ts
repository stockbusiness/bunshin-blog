/**
 * 公開ペースの見直し（TASKS G-8b、作業指示書 W-8）。
 *
 * 2週間ごとにブログ単位で判定し、`article_ratio.weeklyPublishCap` を
 * 上下させる。判定そのものは `publish-pace.ts`（純粋）。
 *
 * ## 母数の作り方
 *
 * 1. そのブログの記事のうち、**公開から14日以上経ったもの**
 *    （`wordpress_posts.published_at`。下書きのままは数えない）
 * 2. そのうち **`metrics_daily.indexed` に判定があるもの**
 *
 * **`indexed` が `NULL` の記事は母数から外す。** G-3 が「分からない」を
 * `false` に倒していないので、ここで倒すと**取得に失敗しただけのブログが
 * 停止される。**
 *
 * **記事ごとに最も新しい判定を使う。** 同じ記事の古い日の判定まで数えると、
 * 長く載っている記事ほど重く数えられる。
 *
 * ## 上限は `blogs` モジュールを通して書く
 *
 * `blogs` テーブルを触ってよいのは `blogs` モジュールだけ
 * （MODULE_RULES 1）。**0本は利用者が設定できない値**（G-8a）なので、
 * 専用の入口（`applyPublishPaceForAdmin`）を `blogs` に足した。
 *
 * ## 記録は監査ログに残す
 *
 * 専用のテーブルを作らない。**ブログに対する自動的な介入**で、
 * ADMIN の介入（`BLOG_SITE_URL_CHANGED`）と同じ性質のもの。
 * 管理画面は `listAuditLogsForAdmin` で読む。
 */

import { prisma } from '@/lib/db';
import { getMailer, type Mailer } from '@/lib/mailer';
import { logger, type Logger } from '@/lib/logger';
import { recordAudit } from '@/modules/audit';
import {
  WEEKLY_PUBLISH_CAP_MAX,
  applyPublishPaceForAdmin,
} from '@/modules/blogs';
import { enqueueJob } from '@/modules/jobs';
import { getRuntimeEnv } from '@/modules/settings';
import { judgePublishPace, isMatureArticle, STOPPED_CAP } from './publish-pace';
import type { PaceJudgement } from './publish-pace';

export interface PaceReviewResult extends PaceJudgement {
  blogId: string;
  /** 母数（公開から14日以上・判定のある記事） */
  judged: number;
  /** そのうち載っていた本数 */
  indexed: number;
  /** 見直す前の上限 */
  previousCap: number;
}

/**
 * 1ブログの公開ペースを見直す。
 *
 * **上限が変わらないときは何も書かない。** 2週間ごとに同じ値を書き直すと、
 * 監査ログが「変わらなかった記録」で埋まり、変わった回が埋もれる。
 *
 * @returns 判定の結果。**書き換えなくても返す**（測れているかを見るため）
 */
export async function reviewPublishPaceForBlog(params: {
  blogId: string;
  now?: Date | undefined;
}): Promise<PaceReviewResult> {
  const now = params.now ?? new Date();

  const blog = await prisma.blog.findUniqueOrThrow({
    where: { id: params.blogId },
    select: { id: true, articleRatio: true },
  });

  const currentCap = readCap(blog.articleRatio);

  const posts = await prisma.wordpressPost.findMany({
    where: { blogId: params.blogId },
    select: { contentItemId: true, publishedAt: true },
  });

  const mature = posts.filter((post) =>
    isMatureArticle({ publishedAt: post.publishedAt, now }),
  );

  let judged = 0;
  let indexed = 0;

  for (const post of mature) {
    // **記事ごとに最も新しい判定を使う。** 古い日の判定まで数えると、
    // 長く載っている記事ほど重く数えられる
    const latest = await prisma.metricDaily.findFirst({
      where: {
        blogId: params.blogId,
        contentItemId: post.contentItemId,
        indexed: { not: null },
      },
      orderBy: { metricDate: 'desc' },
      select: { indexed: true },
    });

    // **判定が無い記事は母数から外す**（「分からない」を「載っていない」に
    // 倒さない。G-3 と同じ）
    if (latest === null) {
      continue;
    }

    judged += 1;

    if (latest.indexed === true) {
      indexed += 1;
    }
  }

  const judgement = judgePublishPace({
    judged,
    indexed,
    currentCap,
    maxCap: WEEKLY_PUBLISH_CAP_MAX,
  });

  const result: PaceReviewResult = {
    ...judgement,
    blogId: params.blogId,
    judged,
    indexed,
    previousCap: currentCap,
  };

  if (judgement.nextCap === currentCap) {
    // **変わらないなら書かない。** 監査ログが「変わらなかった記録」で
    // 埋まると、変わった回が埋もれる
    return result;
  }

  await applyPublishPaceForAdmin({
    blogId: params.blogId,
    weeklyPublishCap: judgement.nextCap,
  });

  await recordAudit({
    // **人が押した操作ではない。** 自動の見直しなので `null`
    actorUserId: null,
    action: 'PUBLISH_CAP_ADJUSTED',
    entityType: 'blog',
    entityId: params.blogId,
    metadata: {
      decision: judgement.decision,
      from: currentCap,
      to: judgement.nextCap,
      // **数えた元も残す。** 率だけだと、5本中4本か100本中80本かが分からない
      judged,
      indexed,
    },
  });

  return result;
}

/** 停止したかどうか。**ADMIN への通知は呼び出し側（ジョブ）が出す** */
export function wasStopped(result: PaceReviewResult): boolean {
  return result.decision === 'STOP' && result.nextCap === STOPPED_CAP;
}

function readCap(articleRatio: unknown): number {
  if (
    typeof articleRatio !== 'object' ||
    articleRatio === null ||
    Array.isArray(articleRatio)
  ) {
    return WEEKLY_PUBLISH_CAP_MAX;
  }

  const value = (articleRatio as Record<string, unknown>)['weeklyPublishCap'];

  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : WEEKLY_PUBLISH_CAP_MAX;
}

export interface PaceReviewDeps {
  mailer?: Mailer | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  logger?: Logger | undefined;
}

/**
 * 全ブログの公開ペースを見直し、止めたものを ADMIN へ通知する（G-8b）。
 *
 * **`SETUP` と `CLOSED` は見ない。** 前者はまだ公開しておらず、
 * 後者はもう公開しない。`PAUSED` は見る — 再開したときの上限が
 * 実測に合っていてほしい。
 *
 * **1ブログの失敗で全体を止めない。** 30ブログを順に見るので、
 * 1件の異常で残りが見直されないほうが困る。
 *
 * @returns 見直した結果（変えなかったものも含む）
 */
export async function reviewPublishPaceForAllBlogs(
  params: { now?: Date | undefined } = {},
  deps: PaceReviewDeps = {},
): Promise<PaceReviewResult[]> {
  const log = deps.logger ?? logger;

  const blogs = await prisma.blog.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const results: PaceReviewResult[] = [];

  for (const blog of blogs) {
    try {
      results.push(
        await reviewPublishPaceForBlog({ blogId: blog.id, ...params }),
      );
    } catch (error) {
      // **1件で全体を止めない。** 残りのブログは見直される
      log.error('公開ペースを見直せなかった', {
        blogId: blog.id,
        cause: error,
      });
    }
  }

  await notifyStopped(results.filter(wasStopped), deps);

  return results;
}

/**
 * 公開を止めたことを ADMIN へ知らせる（W-8）。
 *
 * **黙って止めない。** 止まったブログは記事が出ないだけで、
 * 画面には何も起きていないように見える。
 *
 * **宛先が無いだけで落とさない**（E-15 と同じ）。見直しそのものは
 * 済んでおり、通知は運用の助け。
 */
async function notifyStopped(
  stopped: PaceReviewResult[],
  deps: PaceReviewDeps,
): Promise<number> {
  if (stopped.length === 0) {
    return 0;
  }

  const env = deps.env ?? (await getRuntimeEnv());
  const log = deps.logger ?? logger;
  const to = (env['ADMIN_ALERT_EMAIL'] ?? '').trim();

  if (to === '') {
    log.warn('ADMIN_ALERT_EMAIL が未設定のため公開停止を知らせられない', {
      count: stopped.length,
    });

    return 0;
  }

  const mailer = deps.mailer ?? getMailer({ ...env });
  let sent = 0;

  for (const result of stopped) {
    try {
      await mailer.send({
        to,
        subject: 'インデックス率が低いブログの公開を止めました',
        // **ブログ名を入れない。** 宛先は ADMIN だが、メールは外部を通る。
        // IDがあれば管理画面から辿れる
        text: [
          `ブログ ${result.blogId} の公開を止めました。`,
          '',
          `インデックス率: ${String(result.indexed)} / ${String(result.judged)} 本`,
          `週の公開上限: ${String(result.previousCap)} → 0 本`,
          '',
          '公開から14日以上経った記事のうち、検索に載っているものが半分未満です。',
          'このまま記事を増やしても検索からの流入は増えません。',
          '管理画面で原因を確かめてください。',
        ].join('\n'),
      });
      sent += 1;
    } catch (error) {
      log.error('公開停止を知らせられなかった', {
        blogId: result.blogId,
        cause: error,
      });
    }
  }

  return sent;
}

/** 見直しの間隔（日）。W-8「2週間ごと」 */
export const REVIEW_INTERVAL_DAYS = 14;

/**
 * 見直しの回を表す番号。
 *
 * **間隔を冪等キーに持たせる。** これで、cron が毎分呼んでも
 * **2週間に1回しか積まれない**（C-4）。呼ぶ側が間隔を覚えなくてよく、
 * 呼び忘れても次の分で積まれる。
 */
export function reviewPeriod(now: Date): number {
  return Math.floor(
    now.getTime() / (REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1_000),
  );
}

/**
 * 見直しのジョブを積む（G-8b）。
 *
 * **全ブログを横断する1件**として積む。ブログごとに積むと、
 * 30件のジョブが同時に走って `blogs` を取り合う。
 *
 * @returns 新しく積んだなら `true`。**同じ回で既にあれば `false`**
 */
export async function enqueuePublishPaceReview(
  params: { now?: Date | undefined } = {},
): Promise<boolean> {
  const period = reviewPeriod(params.now ?? new Date());

  const result = await enqueueJob({
    jobType: 'PUBLISH_PACE_REVIEW',
    idempotencyKey: `PUBLISH_PACE_REVIEW:${String(period)}`,
    input: {},
  });

  return result.created;
}
