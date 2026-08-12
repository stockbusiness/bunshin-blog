/**
 * `metrics_daily` の日次集計（TASKS G-6、SPEC 10.2）。
 *
 * 完了条件は「**SPEC 10.2の記録条件が全て保存される**」。
 *
 * ## ここが埋めるのはクリック系だけ
 *
 * SPEC 10.2 が挙げる19項目のうち、**`metrics_daily` に日ごとに
 * 積み上げる必要があるのは生イベントから数えるものだけ**である。
 * 条件（ジャンル・競争レベル・戦略など）はブログの属性として既に
 * 保存されており、**日ごとに写し取る意味が無い**（SPEC 10.3 が
 * 「条件の記録は行い、集計はSQLで実施する」と定めている）。
 *
 * | 項目 | どこにあるか |
 * |---|---|
 * | 検索表示・検索クリック | `metrics_daily`（G-2） |
 * | 成果・収益 | `metrics_daily`（G-5） |
 * | **アフィリエイトクリック** | **ここで `link_clicks` から数える** |
 * | **AI検索経由の流入** | **ここで数える**（G-4 の判別結果） |
 * | 広告クリック・バナー表示 | **記録する経路が無い**（Q-032） |
 * | PV | **GA4 が未実装**（Q-032） |
 * | 条件（ジャンル等） | `blogs` / `genres` / `experiment_groups` |
 *
 * ## 数え直せる
 *
 * 生イベント（`link_clicks`）を残したまま数え直すので、**何度動かしても
 * 同じ結果になる**（C-4）。G-4 で対象ドメインを足したあとに
 * `recountAiReferrals` してから動かせば、過去の日も正しくなる。
 *
 * ## 自分の列だけ書く
 *
 * 同じ行には検索データ（G-2）・手入力の成果（G-5）・インデックス（G-3）が
 * 入っている。**行ごと置き換えない。**
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  jstDateColumn,
  jstDayRange,
  todayInJst,
  type JstDate,
} from '@/lib/datetime';
import { requireBlogForUser } from '@/modules/blogs';
import { enqueueJob } from '@/modules/jobs';

/**
 * さかのぼって数え直す日数。
 *
 * **その日の途中で動くと、その日はまだ増える。** 翌日以降にもう一度
 * 数え直さないと、最終日が少ないまま残る。G-2 と同じ考え方だが、
 * こちらは自前のデータなので短くてよい。
 */
export const AGGREGATE_LOOKBACK_DAYS = 3;

export interface DailyAggregateSummary {
  blogId: string;
  dates: readonly JstDate[];
  /** 書いた行数（ブログ全体＋記事ごと） */
  written: number;
}

/** 1日ぶんの数 */
interface Counts {
  affiliateClicks: number;
  aiReferrals: number;
}

function emptyCounts(): Counts {
  return { affiliateClicks: 0, aiReferrals: 0 };
}

/**
 * ブログのクリックを日ごとに数え直す。
 *
 * **記事に紐づかないクリックも全体には数える。** `affiliate_links` は
 * `content_item_id` を持たないことがある（記事に貼る前の案件など）。
 * 記事別の行は作れないが、**ブログ全体の数からは落とさない** —
 * 落とすと「記事の合計＝ブログ全体」に見えて、実際より少なく読める。
 */
export async function aggregateDailyMetricsForUser(params: {
  userId: string;
  blogId: string;
  now?: Date;
  days?: number;
}): Promise<DailyAggregateSummary> {
  const blog = await requireBlogForUser(params);
  const days = Math.max(1, params.days ?? AGGREGATE_LOOKBACK_DAYS);
  const today = todayInJst(params.now ?? new Date());

  const dates: JstDate[] = [];

  for (let index = 0; index < days; index += 1) {
    dates.push(shiftJstDate(today, index));
  }

  let written = 0;

  for (const date of dates) {
    written += await aggregateOneDay(blog.id, date);
  }

  return { blogId: blog.id, dates, written };
}

/** `YYYY-MM-DD` を日数だけ戻す */
function shiftJstDate(date: JstDate, days: number): JstDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);

  return shifted.toISOString().slice(0, 10);
}

async function aggregateOneDay(blogId: string, date: JstDate): Promise<number> {
  const range = jstDayRange(date);

  const clicks = await prisma.linkClick.findMany({
    where: {
      clickedAt: { gte: range.start, lt: range.endExclusive },
      affiliateLink: { blogId },
    },
    select: {
      isAiReferral: true,
      affiliateLink: { select: { contentItemId: true } },
    },
  });

  const byItem = new Map<string, Counts>();
  const total = emptyCounts();

  for (const click of clicks) {
    total.affiliateClicks += 1;

    if (click.isAiReferral) {
      total.aiReferrals += 1;
    }

    // `affiliateLink` は D-12 で nullable になった（バナーのクリックが
    // 同じ表に入るため）。**この問い合わせは `affiliateLink: { blogId }` で
    // 絞っているので、ここへ来る行は必ず持っている** — 型のために `?.` を置く。
    // バナーのクリックを `banner_clicks` へ数えるのは D-12 の担当
    const contentItemId = click.affiliateLink?.contentItemId ?? null;

    // **記事に紐づかないクリックは全体にだけ数える**
    if (contentItemId === null) {
      continue;
    }

    const counts = byItem.get(contentItemId) ?? emptyCounts();
    counts.affiliateClicks += 1;

    if (click.isAiReferral) {
      counts.aiReferrals += 1;
    }

    byItem.set(contentItemId, counts);
  }

  const metricDate = jstDateColumn(date);
  let written = 0;

  // **0でも書く。** 「数えた結果0」と「まだ数えていない」を分ける。
  // ただし**行がまだ無いなら作らない** — クリックが一度も無いブログの
  // 空行で表を埋めない
  written += await writeCounts({
    blogId,
    contentItemId: null,
    metricDate,
    counts: total,
    createIfMissing: total.affiliateClicks > 0,
  });

  for (const [contentItemId, counts] of byItem) {
    written += await writeCounts({
      blogId,
      contentItemId,
      metricDate,
      counts,
      createIfMissing: true,
    });
  }

  // **前の実行で入った数を残さない。** クリックが消えることは無いが、
  // 記事が削除されると行だけが残る。ここでは触らず、
  // 数え直しの対象は「その日にクリックがあった記事」に限る

  return written;
}

/**
 * 数だけを書く。
 *
 * **触るのは `affiliate_clicks` と `ai_referrals` の2列。**
 * 同じ行には検索データ（G-2）・成果（G-5）・インデックス（G-3）が入っている。
 */
async function writeCounts(params: {
  blogId: string;
  contentItemId: string | null;
  metricDate: Date;
  counts: Counts;
  createIfMissing: boolean;
}): Promise<number> {
  const data = {
    affiliateClicks: params.counts.affiliateClicks,
    aiReferrals: params.counts.aiReferrals,
  };

  const existing = await prisma.metricDaily.findFirst({
    where: {
      blogId: params.blogId,
      contentItemId: params.contentItemId,
      metricDate: params.metricDate,
    },
    select: { id: true },
  });

  if (existing !== null) {
    await prisma.metricDaily.update({ where: { id: existing.id }, data });
    return 1;
  }

  if (!params.createIfMissing) {
    return 0;
  }

  try {
    await prisma.metricDaily.create({
      data: {
        blogId: params.blogId,
        contentItemId: params.contentItemId,
        metricDate: params.metricDate,
        ...data,
      },
    });

    return 1;
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }

    const row = await prisma.metricDaily.findFirst({
      where: {
        blogId: params.blogId,
        contentItemId: params.contentItemId,
        metricDate: params.metricDate,
      },
      select: { id: true },
    });

    if (row === null) {
      return 0;
    }

    await prisma.metricDaily.update({ where: { id: row.id }, data });

    return 1;
  }
}

/**
 * 集計ジョブを積む（C-4）。
 *
 * **ブログごとに1件、1日1回。** 検索データ（G-2）と分ける理由は
 * 外部に依存しないこと — Google が落ちていても、こちらは数えられる。
 *
 * @returns 新しく積んだ件数
 */
export async function enqueueDailyAggregateForUser(
  userId: string,
  deps: { now?: Date | undefined } = {},
): Promise<number> {
  const date = todayInJst(deps.now ?? new Date());

  const blogs = await prisma.blog.findMany({
    where: { userId, status: { not: 'CLOSED' } },
    select: { id: true },
  });

  let queued = 0;

  for (const blog of blogs) {
    const result = await enqueueJob({
      jobType: 'METRICS_AGGREGATE',
      idempotencyKey: `METRICS_AGGREGATE:${blog.id}:${date}`,
      input: {},
      userId,
      blogId: blog.id,
    });

    if (result.created) {
      queued += 1;
    }
  }

  return queued;
}
