import { prisma } from '@/lib/db';
import { MAX_BLOGS_PER_USER } from './slots';

/**
 * 管理画面向けのブログ数集計（B-7、SPEC 6.2 の「3ブログ状態」）。
 *
 * **ADMIN 専用。`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 *
 * blogs モジュールの他の関数は必ず `userId` で絞る（SPEC 14.1）。
 * ここだけは横断して数えるため、**名前で用途を明示し、モニター向けの
 * 経路から呼べないようにこのファイルへ隔離する**。
 */

export interface AdminBlogCount {
  /** `CLOSED` を除いた数。画面で「稼働中」として見せる */
  open: number;
  /** `CLOSED` の数。枠は埋まったまま（OPEN_QUESTIONS Q-008） */
  closed: number;
  /** 使用済みの枠。`open + closed`。上限は `MAX_BLOGS_PER_USER` */
  usedSlots: number;
}

export const EMPTY_BLOG_COUNT: AdminBlogCount = {
  open: 0,
  closed: 0,
  usedSlots: 0,
};

/** `groupBy` が返す1行ぶん */
export interface BlogStatusCountRow {
  userId: string;
  status: string;
  count: number;
}

/**
 * 集計結果をユーザー単位にまとめる。
 *
 * **DBに触らない純粋関数。** `CLOSED` を稼働側へ混ぜていないか、
 * 使用枠に数えているか（Q-008）を、実DBを起こさずに固定できる。
 */
export function toBlogCounts(
  rows: readonly BlogStatusCountRow[],
): Record<string, AdminBlogCount> {
  const counts: Record<string, AdminBlogCount> = {};

  for (const row of rows) {
    const current = counts[row.userId] ?? { ...EMPTY_BLOG_COUNT };

    if (row.status === 'CLOSED') {
      current.closed += row.count;
    } else {
      current.open += row.count;
    }
    current.usedSlots = current.open + current.closed;

    counts[row.userId] = current;
  }

  return counts;
}

/**
 * ユーザーIDごとのブログ数を数える。
 *
 * **1件ずつ引かない。** モニター10名×3ブログでも問い合わせは1回で済む。
 * 一覧の行数だけクエリを出す作りにすると、モニターが増えたときに
 * 管理画面から順に遅くなる。
 *
 * 戻り値に含まれるのは1件以上持つユーザーのみ。0件のユーザーは
 * `EMPTY_BLOG_COUNT` を使う。
 */
export async function countBlogsByUserForAdmin(): Promise<
  Record<string, AdminBlogCount>
> {
  const rows = await prisma.blog.groupBy({
    by: ['userId', 'status'],
    _count: { _all: true },
  });

  return toBlogCounts(
    rows.map((row) => ({
      userId: row.userId,
      status: row.status,
      count: row._count._all,
    })),
  );
}

export { MAX_BLOGS_PER_USER };
