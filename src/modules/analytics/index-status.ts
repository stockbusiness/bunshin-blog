/**
 * インデックス状況の取得（TASKS G-3、SPEC 11.3・11.2「インデックス率」）。
 *
 * 完了条件は「**URL Inspection の結果が保存される**」。
 *
 * ## なぜ別ジョブなのか
 *
 * **上限の枠が違う。** Search Analytics（G-2）は1ブログにつき1日数回だが、
 * こちらは**記事の本数だけ呼ぶ**。1プロパティ1日2,000回の枠が実際に効く。
 *
 * 同じジョブに入れると、**上限に当たったときに、取れていたはずの
 * 検索データまで巻き戻る。** 分けておけば、失敗するのはこちらだけ。
 *
 * ## 「分からない」を `false` に倒さない
 *
 * `metrics_daily.indexed` は `NULL` を取れる。Google が判断を返さなかった日は
 * **書かない**。`false` にすると「調べたが載っていない」と区別できず、
 * インデックス率（SPEC 11.2）が実際より低く出る。
 *
 * ## 日付はJSTの今日
 *
 * 索引の有無は**いま尋ねた結果**であって、過去の日に遡って当てはまらない。
 * 検索データ（G-2）は Search Console が返した暦日を使うため、
 * **同じ行の中で基準が違う**。Q-005 が「最大1日ずれる」と書いたのと同じ話で、
 * 全ブログに等しくかかるので比較は歪まない。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  createUrlInspectionClient,
  fetchAccessToken,
  parseServiceAccountKey,
  GoogleNotConfiguredError,
  type UrlInspectionClient,
} from '@/lib/google';
import { startOfJstDay, todayInJst } from '@/lib/datetime';
import { requireBlogForUser } from '@/modules/blogs';
import { enqueueJob } from '@/modules/jobs';
import { getRuntimeEnv } from '@/modules/settings';

/**
 * 1回の実行で調べる本数の上限。
 *
 * **Google の枠（1日2,000回）より十分小さく取る。** Phase 0 は
 * 1ブログあたり週4本×12週で50本ほど（SPEC 2.2）なので、
 * この数で全記事に届く。**枠に張り付かせない**ための余裕である。
 */
export const URL_INSPECTION_PER_RUN = 200;

export interface IndexStatusDeps {
  client?: UrlInspectionClient | undefined;
}

/**
 * 設定からクライアントを作る。
 *
 * @throws {GoogleNotConfiguredError} 鍵が未設定
 */
export async function createConfiguredUrlInspectionClient(): Promise<UrlInspectionClient> {
  const env = await getRuntimeEnv();
  const raw = env['GOOGLE_SERVICE_ACCOUNT_KEY']?.trim() ?? '';

  if (raw === '') {
    throw new GoogleNotConfiguredError(['GOOGLE_SERVICE_ACCOUNT_KEY']);
  }

  const token = await fetchAccessToken(parseServiceAccountKey(raw));

  return createUrlInspectionClient(token);
}

export interface IndexStatusSummary {
  blogId: string;
  /** 調べた本数 */
  inspected: number;
  indexed: number;
  notIndexed: number;
  /** Google が判断を返さなかった本数。**書いていない** */
  unknown: number;
}

/**
 * 1ブログぶん調べる。
 *
 * **今日ぶんを既に記録した記事は飛ばす。** 同じ日に2回動いても
 * 呼び出しの枠を二重に使わない（C-4）。
 */
export async function fetchIndexStatusForUser(
  params: { userId: string; blogId: string; now?: Date; limit?: number },
  deps: IndexStatusDeps = {},
): Promise<IndexStatusSummary | null> {
  const blog = await requireBlogForUser(params);

  const connection = await prisma.searchConsoleConnection.findUnique({
    where: { blogId: blog.id },
    select: { propertyUrl: true, connectionStatus: true },
  });

  if (connection === null || connection.connectionStatus !== 'CONNECTED') {
    return null;
  }

  const now = params.now ?? new Date();
  const metricDate = startOfJstDay(todayInJst(now));
  const limit = params.limit ?? URL_INSPECTION_PER_RUN;

  const posts = await prisma.wordpressPost.findMany({
    where: { blogId: blog.id, wpPostUrl: { not: null } },
    select: { contentItemId: true, wpPostUrl: true },
    // **古い記事から。** 新しい記事は次の実行でも間に合う
    orderBy: { postedAt: 'asc' },
  });

  const client = deps.client ?? (await createConfiguredUrlInspectionClient());
  const summary: IndexStatusSummary = {
    blogId: blog.id,
    inspected: 0,
    indexed: 0,
    notIndexed: 0,
    unknown: 0,
  };

  for (const post of posts) {
    if (summary.inspected >= limit) {
      break;
    }

    if (post.wpPostUrl === null) {
      continue;
    }

    const existing = await prisma.metricDaily.findFirst({
      where: {
        blogId: blog.id,
        contentItemId: post.contentItemId,
        metricDate,
      },
      select: { id: true, indexed: true },
    });

    // **今日ぶんが既にあるなら呼ばない。** 枠を二重に使わない
    if (existing !== null && existing.indexed !== null) {
      continue;
    }

    const result = await client.inspect({
      propertyUrl: connection.propertyUrl,
      pageUrl: post.wpPostUrl,
    });

    summary.inspected += 1;

    if (result.verdict === 'UNKNOWN') {
      // **書かない。** `false` に倒すとインデックス率が実際より低く出る
      summary.unknown += 1;
      continue;
    }

    const indexed = result.verdict === 'INDEXED';

    if (indexed) {
      summary.indexed += 1;
    } else {
      summary.notIndexed += 1;
    }

    await writeIndexed({
      id: existing?.id ?? null,
      blogId: blog.id,
      contentItemId: post.contentItemId,
      metricDate,
      indexed,
    });
  }

  return summary;
}

/**
 * `indexed` だけを書く。
 *
 * **他の列に触らない。** 同じ行には検索データ（G-2）と
 * 手入力の成果（G-5）が入っている。
 */
async function writeIndexed(params: {
  id: string | null;
  blogId: string;
  contentItemId: string;
  metricDate: Date;
  indexed: boolean;
}): Promise<void> {
  if (params.id !== null) {
    await prisma.metricDaily.update({
      where: { id: params.id },
      data: { indexed: params.indexed },
    });
    return;
  }

  try {
    await prisma.metricDaily.create({
      data: {
        blogId: params.blogId,
        contentItemId: params.contentItemId,
        metricDate: params.metricDate,
        indexed: params.indexed,
      },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }

    // 同時に2回来た場合。**握り潰さず、既にある行へ書き直す**
    const row = await prisma.metricDaily.findFirst({
      where: {
        blogId: params.blogId,
        contentItemId: params.contentItemId,
        metricDate: params.metricDate,
      },
      select: { id: true },
    });

    if (row !== null) {
      await prisma.metricDaily.update({
        where: { id: row.id },
        data: { indexed: params.indexed },
      });
    }
  }
}

/**
 * 取得ジョブを積む（C-4）。
 *
 * **ブログごとに1件、1日1回**（冪等キーにJSTの日付を入れる）。
 * 検索データの取得（G-2）とは**別のジョブ**にする — 上限の枠が違い、
 * こちらが上限に当たっても検索データを巻き戻さないため。
 *
 * @returns 新しく積んだ件数
 */
export async function enqueueIndexStatusForUser(
  userId: string,
  deps: { now?: Date | undefined } = {},
): Promise<number> {
  const date = todayInJst(deps.now ?? new Date());

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
      jobType: 'URL_INSPECTION',
      idempotencyKey: `URL_INSPECTION:${connection.blogId}:${date}`,
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
