/**
 * 手動の収益入力（TASKS G-5、SPEC 6.1 `/liff/results`、SPEC 10.2）。
 *
 * 完了条件は「**成果件数と報酬額のみ入力。0件を1操作で記録できる**」。
 *
 * ## 「0件」と「未報告」を分ける
 *
 * これが完了条件に「0件を1操作で」と書かれている理由である。
 *
 * 0件の週にわざわざ数字を入れるのは面倒なので、**放っておかれる。**
 * すると `metrics_daily` に行が無い週が並び、あとから見たときに
 * **「成果が無かった」のか「報告されなかった」のかが分からない。**
 *
 * 行が無い＝未報告、行があって `conversions = 0`＝0件と報告済み、と
 * 読めるようにする。そのために**ボタン1つで0を記録できる**必要がある。
 *
 * ## 週の単位はJSTの月曜始まり
 *
 * `metrics_daily` は日付の表だが、手動の入力は週次（SPEC 6.1）。
 * **その週の月曜日の行に入れる。** 週の途中の日付に入れると、
 * 同じ週に2回入力したときに別の行になる。
 *
 * ## 記事ではなくブログに対して記録する
 *
 * ASPの管理画面が返すのはブログ単位（サブID経由で記事まで分かることも
 * あるが、モニターに手で分解させない）。`content_item_id` は `NULL`。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import {
  startOfJstDay,
  startOfJstWeek,
  todayInJst,
  type JstDate,
} from '@/lib/datetime';
import { requireBlogForUser } from '@/modules/blogs';

export const WEEKLY_RESULT_ERROR_CODES = {
  invalidInput: 'WEEKLY_RESULT_INVALID',
} as const;

/** 1週間の成果として受け付ける上限（打ち間違いを弾く） */
export const MAX_CONVERSIONS_PER_WEEK = 10_000;
export const MAX_REVENUE_YEN_PER_WEEK = 100_000_000;

function invalidError(reason: string): AppError {
  return new AppError(
    WEEKLY_RESULT_ERROR_CODES.invalidInput,
    422,
    `入力を確認してください：${reason}`,
  );
}

export interface WeeklyResultInput {
  /** 成果件数。**0を明示できる** */
  conversions: number;
  /** 報酬額（円）。成果が0なら0 */
  revenueYen: number;
}

/**
 * 入力を確かめる。
 *
 * **負の数を受け付けない。** 成果を取り消したい場合も、
 * その週の値を入れ直すことで表す（上書きするため）。
 *
 * **小数を受け付けない。** 件数も円も整数。
 */
export function normalizeWeeklyResult(input: {
  conversions: unknown;
  revenueYen: unknown;
}): WeeklyResultInput {
  const conversions = toCount(input.conversions, '成果件数');
  const revenueYen = toCount(input.revenueYen, '報酬額');

  if (conversions > MAX_CONVERSIONS_PER_WEEK) {
    throw invalidError(`成果件数が大きすぎます（${conversions}）`);
  }

  if (revenueYen > MAX_REVENUE_YEN_PER_WEEK) {
    throw invalidError(`報酬額が大きすぎます（${revenueYen}）`);
  }

  // **0件なのに報酬があるのは打ち間違い。** 逆（成果があるのに0円）は
  // ありうる（承認待ちの案件など）ので通す
  if (conversions === 0 && revenueYen > 0) {
    throw invalidError('成果が0件なのに報酬額が入っています');
  }

  return { conversions, revenueYen };
}

function toCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return failNumber(label);
  }

  if (!Number.isInteger(value)) {
    throw invalidError(`${label}は整数で入力してください`);
  }

  if (value < 0) {
    throw invalidError(`${label}に負の数は入れられません`);
  }

  return value;
}

function failNumber(label: string): never {
  throw invalidError(`${label}を数字で入力してください`);
}

/** その日を含む週の月曜日（JST） */
export function weekOf(now: Date = new Date()): JstDate {
  return startOfJstWeek(todayInJst(now));
}

export interface WeeklyResult {
  blogId: string;
  weekStart: JstDate;
  conversions: number;
  revenueYen: number;
  updatedAt: Date;
}

/**
 * その週の成果を記録する。
 *
 * **同じ週に入れ直すと上書きする。** 週の途中で確定していない値を
 * 入れておき、あとで直せる。
 *
 * @throws {AppError} 自分のブログでない・入力が受け付けられない
 */
export async function saveWeeklyResultForUser(
  params: { userId: string; blogId: string; weekStart?: JstDate | undefined },
  input: { conversions: unknown; revenueYen: unknown },
): Promise<WeeklyResult> {
  const blog = await requireBlogForUser(params);
  const normalized = normalizeWeeklyResult(input);
  const weekStart = params.weekStart ?? weekOf();
  const metricDate = startOfJstDay(weekStart);

  // **`upsert` を使えない。** Prisma は複合一意の `where` に `null` を
  // 受け付けない（DB側は `NULLS NOT DISTINCT` で一意。G-5-schema）。
  // 引いてから書くが、**同時に2回来ても重複しないのはDBの制約のおかげ**
  const existing = await prisma.metricDaily.findFirst({
    where: { blogId: blog.id, contentItemId: null, metricDate },
    select: { id: true },
  });

  const row =
    existing === null
      ? await createRow({
          blogId: blog.id,
          metricDate,
          input: normalized,
        })
      : await prisma.metricDaily.update({
          where: { id: existing.id },
          data: {
            conversions: normalized.conversions,
            revenueYen: normalized.revenueYen,
          },
          select: { conversions: true, revenueYen: true, updatedAt: true },
        });

  return {
    blogId: blog.id,
    weekStart,
    conversions: row.conversions,
    revenueYen: row.revenueYen,
    updatedAt: row.updatedAt,
  };
}

/**
 * 行を作る。
 *
 * **同時に2回来たら片方が一意違反で落ちる**（G-5-schema）。
 * 握り潰さず、既にある行へ書き直す — 利用者から見れば「保存できた」で
 * よく、どちらの実行が勝ったかは意味を持たない。
 */
async function createRow(params: {
  blogId: string;
  metricDate: Date;
  input: WeeklyResultInput;
}): Promise<{ conversions: number; revenueYen: number; updatedAt: Date }> {
  try {
    return await prisma.metricDaily.create({
      data: {
        blogId: params.blogId,
        metricDate: params.metricDate,
        conversions: params.input.conversions,
        revenueYen: params.input.revenueYen,
      },
      select: { conversions: true, revenueYen: true, updatedAt: true },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      throw error;
    }

    return prisma.metricDaily.update({
      where: {
        blogId_contentItemId_metricDate: {
          blogId: params.blogId,
          contentItemId: null as never,
          metricDate: params.metricDate,
        },
      },
      data: {
        conversions: params.input.conversions,
        revenueYen: params.input.revenueYen,
      },
      select: { conversions: true, revenueYen: true, updatedAt: true },
    });
  }
}

export interface WeeklyResultRow {
  weekStart: string;
  conversions: number;
  revenueYen: number;
  /** **報告されたか。** 行が無ければ `false`（0件の報告と区別する） */
  reported: boolean;
}

/**
 * 直近の週の成果を返す（新しい週が先）。
 *
 * **報告の無い週も行として返す。** 返さないと、画面が
 * 「0件だった週」と「入力し忘れた週」を区別して見せられない。
 */
export async function listWeeklyResultsForUser(
  params: { userId: string; blogId: string },
  options: { weeks?: number; now?: Date } = {},
): Promise<WeeklyResultRow[]> {
  const blog = await requireBlogForUser(params);
  const weeks = Math.min(Math.max(1, options.weeks ?? 8), 52);
  const now = options.now ?? new Date();

  const starts: JstDate[] = [];
  let cursor = weekOf(now);

  for (let index = 0; index < weeks; index += 1) {
    starts.push(cursor);
    cursor = startOfJstWeek(
      todayInJst(new Date(startOfJstDay(cursor).getTime() - 24 * 60 * 60_000)),
    );
  }

  const rows = await prisma.metricDaily.findMany({
    where: {
      blogId: blog.id,
      contentItemId: null,
      metricDate: { in: starts.map((start) => startOfJstDay(start)) },
    },
    select: { metricDate: true, conversions: true, revenueYen: true },
  });

  const byDate = new Map(
    rows.map((row) => [row.metricDate.toISOString().slice(0, 10), row]),
  );

  return starts.map((start) => {
    const found = byDate.get(startOfJstDay(start).toISOString().slice(0, 10));

    return {
      weekStart: start,
      conversions: found?.conversions ?? 0,
      revenueYen: found?.revenueYen ?? 0,
      // **行が無い＝未報告。** 0件の報告と区別する
      reported: found !== undefined,
    };
  });
}
