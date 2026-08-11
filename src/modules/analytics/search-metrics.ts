/**
 * Search Analytics を `metrics_daily` へ入れる（TASKS G-2、SPEC 11.3・10.2）。
 *
 * 完了条件は「日次で表示回数・クリック・順位を保存。**API上限を考慮**」。
 *
 * ## 昨日ぶんだけ取らない
 *
 * **Search Console のデータは遅れて確定する。** 昨日ぶんを取りに行っても
 * 空か、少ない数字が返る。そこで保存して終わりにすると、
 * **取りこぼしたまま二度と取り直さない。**
 *
 * 毎回**直近数日を取り直して上書きする**。ジョブは何度動いても同じ結果になり
 * （C-4）、遅れて入った数字も次の実行で入る。
 *
 * ## ブログ全体を「ページの合計」で代用しない
 *
 * `page` 次元で取った行を足し上げても、**ブログ全体の数字にはならない。**
 * 1回の検索で複数ページが出れば表示は重複して数えられ、
 * 平均掲載順位は**加重平均なので足せない**。
 *
 * そこで**2回問い合わせる。**
 *
 * | 次元 | 入れる先 |
 * |---|---|
 * | `date` | `content_item_id` が `NULL` の行（ブログ全体） |
 * | `date` + `page` | 記事ごとの行 |
 *
 * 全体はGoogleに集計させた値をそのまま入れる。
 *
 * ## 自分の列だけ書く
 *
 * 同じ行に手入力の成果（G-5）が入っている。**行ごと置き換えない。**
 * 触るのは `impressions` `search_clicks` `average_position` の3つだけ。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  createSearchAnalyticsClient,
  fetchAccessToken,
  parseServiceAccountKey,
  GoogleNotConfiguredError,
  type SearchAnalyticsClient,
  type SearchAnalyticsRow,
} from '@/lib/google';
import { todayInJst, jstDateColumn, type JstDate } from '@/lib/datetime';
import { requireBlogForUser } from '@/modules/blogs';
import { enqueueJob } from '@/modules/jobs';
import { getRuntimeEnv } from '@/modules/settings';

/**
 * さかのぼって取り直す日数。
 *
 * **Search Console のデータは2〜3日遅れて確定する。** 余裕を見て5日。
 * 短くすると遅れて入った数字を取りこぼし、長くしても
 * 上書きされるだけで害は無い（費用は問い合わせ1回ぶん）。
 */
export const LOOKBACK_DAYS = 5;

/**
 * Search Console が返した日付をそのまま使う（Q-005 の決定 (a)）。
 *
 * 返るのは時刻を持たない日付文字列で、**JSTの暦日へ割り直すことは
 * 原理的にできない。** ずれは全ブログに等しくかかるため、比較は歪まない。
 */
function toMetricDate(dateKey: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }

  // **`date` 型の列には暦日をそのまま渡す**（Q-031）。
  // `startOfJstDay` を渡すと1日前が保存される
  return jstDateColumn(dateKey as JstDate);
}

/** `YYYY-MM-DD` を日数だけ戻す */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);

  return shifted.toISOString().slice(0, 10);
}

/** 取りに行く期間。**終端は今日**（確定していない日も含めて取り直す） */
export function fetchWindow(now: Date = new Date()): {
  startDate: string;
  endDate: string;
} {
  const endDate = todayInJst(now);

  return { startDate: shiftDate(endDate, LOOKBACK_DAYS - 1), endDate };
}

export interface SearchMetricsDeps {
  /** 差し替え用。既定は実HTTP */
  client?: SearchAnalyticsClient | undefined;
}

/**
 * 設定からクライアントを作る。
 *
 * @throws {GoogleNotConfiguredError} 鍵が未設定
 */
export async function createConfiguredSearchAnalyticsClient(): Promise<SearchAnalyticsClient> {
  const env = await getRuntimeEnv();
  const raw = env['GOOGLE_SERVICE_ACCOUNT_KEY']?.trim() ?? '';

  if (raw === '') {
    throw new GoogleNotConfiguredError(['GOOGLE_SERVICE_ACCOUNT_KEY']);
  }

  const token = await fetchAccessToken(parseServiceAccountKey(raw));

  return createSearchAnalyticsClient(token);
}

export interface SearchMetricsSummary {
  blogId: string;
  startDate: string;
  endDate: string;
  /** 書いたブログ全体の行数（＝取れた日数） */
  blogDays: number;
  /** 書いた記事ごとの行数 */
  articleRows: number;
  /** 記事に結びつけられなかったページの数。**0でないことは異常ではない** */
  unmatchedPages: number;
}

/**
 * 1ブログぶん取り込む。
 *
 * **未連携・読めない状態のブログは叩かない。** 叩いても失敗するだけで、
 * 呼び出しの上限を無駄に使う。
 */
export async function fetchSearchMetricsForUser(
  params: { userId: string; blogId: string; now?: Date },
  deps: SearchMetricsDeps = {},
): Promise<SearchMetricsSummary | null> {
  const blog = await requireBlogForUser(params);

  const connection = await prisma.searchConsoleConnection.findUnique({
    where: { blogId: blog.id },
    select: { propertyUrl: true, connectionStatus: true },
  });

  if (connection === null || connection.connectionStatus !== 'CONNECTED') {
    return null;
  }

  const client = deps.client ?? (await createConfiguredSearchAnalyticsClient());
  const window = fetchWindow(params.now ?? new Date());

  const query = {
    propertyUrl: connection.propertyUrl,
    startDate: window.startDate,
    endDate: window.endDate,
  };

  // **全体を先に取る。** ここが入っていれば、記事別が空でも
  // 「取れていない」と「記事に結びつかなかった」を見分けられる
  const blogRows = await client.query({ ...query, dimensions: ['date'] });
  const blogDays = await saveBlogRows(blog.id, blogRows);

  const pageRows = await client.query({
    ...query,
    dimensions: ['date', 'page'],
  });
  const saved = await saveArticleRows(blog.id, pageRows);

  await prisma.searchConsoleConnection.update({
    where: { blogId: blog.id },
    data: { lastSyncedAt: new Date(), lastErrorCode: null },
  });

  return {
    blogId: blog.id,
    startDate: window.startDate,
    endDate: window.endDate,
    blogDays,
    articleRows: saved.written,
    unmatchedPages: saved.unmatched,
  };
}

async function saveBlogRows(
  blogId: string,
  rows: readonly SearchAnalyticsRow[],
): Promise<number> {
  let written = 0;

  for (const row of rows) {
    const metricDate = toMetricDate(row.keys[0] ?? '');

    if (metricDate === null) {
      continue;
    }

    await writeMetrics({
      blogId,
      contentItemId: null,
      metricDate,
      row,
    });

    written += 1;
  }

  return written;
}

/**
 * ページのURLを記事に結びつける。
 *
 * **結びつかないページは捨てる。** モニターが自分で書いた記事や
 * トップページが返るのは正常で、ブログ全体の数字は別に取ってある。
 */
async function saveArticleRows(
  blogId: string,
  rows: readonly SearchAnalyticsRow[],
): Promise<{ written: number; unmatched: number }> {
  const posts = await prisma.wordpressPost.findMany({
    where: { blogId, wpPostUrl: { not: null } },
    select: { contentItemId: true, wpPostUrl: true },
  });

  const byUrl = new Map<string, string>();

  for (const post of posts) {
    if (post.wpPostUrl !== null) {
      byUrl.set(normalizePageUrl(post.wpPostUrl), post.contentItemId);
    }
  }

  let written = 0;
  const unmatchedUrls = new Set<string>();

  for (const row of rows) {
    const metricDate = toMetricDate(row.keys[0] ?? '');
    const page = row.keys[1];

    if (metricDate === null || page === undefined) {
      continue;
    }

    const contentItemId = byUrl.get(normalizePageUrl(page));

    if (contentItemId === undefined) {
      unmatchedUrls.add(page);
      continue;
    }

    await writeMetrics({ blogId, contentItemId, metricDate, row });
    written += 1;
  }

  return { written, unmatched: unmatchedUrls.size };
}

/**
 * URLを突き合わせられる形に揃える。
 *
 * **末尾の `/` と大文字小文字で取り逃さない。** WordPress のパーマリンクは
 * 末尾に `/` が付き、Search Console が返すURLと食い違うことがある。
 * ここで揃えないと、**記事があるのに0件として並ぶ。**
 */
export function normalizePageUrl(raw: string): string {
  let parsed: URL;

  try {
    parsed = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  const path = parsed.pathname.endsWith('/')
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;

  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
}

/**
 * 1行ぶん書く。
 *
 * **`upsert` を使えない。** Prisma は複合一意の `where` に `null` を
 * 受け付けない（DB側は `NULLS NOT DISTINCT` で一意。G-5-schema）。
 *
 * **触るのは自分の3列だけ。** 同じ行には手入力の成果（G-5）が入っている。
 */
async function writeMetrics(params: {
  blogId: string;
  contentItemId: string | null;
  metricDate: Date;
  row: SearchAnalyticsRow;
}): Promise<void> {
  const data = {
    impressions: Math.round(params.row.impressions),
    searchClicks: Math.round(params.row.clicks),
    averagePosition: new Prisma.Decimal(params.row.position.toFixed(2)),
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
    return;
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
  } catch (error) {
    // **同時に2回来たら片方が一意違反で落ちる**（G-5-schema）。
    // 握り潰さず、既にある行へ書き直す
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

    if (row !== null) {
      await prisma.metricDaily.update({ where: { id: row.id }, data });
    }
  }
}

/**
 * 取得ジョブを積む（C-4）。
 *
 * **ブログごとに1件積む。** 1件で3ブログ回すと、2つ目で落ちたときに
 * 1つ目までやり直すことになる。ブログ単位なら、失敗した1つだけが再試行される。
 *
 * **同じ日に何度呼んでも1回だけ**（冪等キーにJSTの日付を入れる）。
 * 日が変われば取り直す — 遅れて確定した数字が入る。
 *
 * **未連携・読めない状態のブログは積まない。** 積んでも失敗するだけで、
 * 再試行の回数と呼び出しの上限を無駄に使う。
 *
 * @returns 新しく積んだ件数
 */
export async function enqueueSearchMetricsForUser(
  userId: string,
  deps: { now?: Date | undefined } = {},
): Promise<number> {
  const now = deps.now ?? new Date();
  const date = todayInJst(now);

  const connections = await prisma.searchConsoleConnection.findMany({
    where: {
      connectionStatus: 'CONNECTED',
      blog: { userId, status: { not: 'CLOSED' } },
    },
    select: { blogId: true },
  });

  let queued = 0;

  for (const connection of connections) {
    const result = await enqueueJob({
      jobType: 'SEARCH_CONSOLE_FETCH',
      idempotencyKey: `SEARCH_CONSOLE_FETCH:${connection.blogId}:${date}`,
      input: {},
      userId,
      blogId: connection.blogId,
    });

    if (result.created) {
      queued += 1;
    }
  }

  return queued;
}
