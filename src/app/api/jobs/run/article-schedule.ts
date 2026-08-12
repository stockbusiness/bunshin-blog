import { jstWeekNumber, todayInJst, toJstDate } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { listBlogsForUser } from '@/modules/blogs';
import { listGenerationTargetsForUser } from '@/modules/content-planning';
import { enqueueJob } from '@/modules/jobs';

/**
 * 記事生成の積み込み（TASKS I-4、SPEC 9.2・4.3）。
 *
 * ## なぜ必要だったのか
 *
 * **E-10 は「1本生成する関数」まで作ったが、それを呼ぶ人がいなかった**
 * （棚卸し・2026-08-12。I-1・I-2 と同じ穴）。構成表は作られても、
 * **記事は1本も書かれない**状態だった。
 *
 * ## 公開する曜日にだけ積む
 *
 * ブログごとに曜日が散らしてある（C-9）。**全ブログの記事が同じ日に
 * 生まれると、同一運営者による大量サイトの痕跡になる**（W-8）。
 *
 * ## 上限をここで数え直さない
 *
 * **週あたりの本数は `assignPublishOrder` が週へ詰める時点で効いている**
 * （C-9・G-8a）。ここは「その週まで」に絞るだけで、**上限を再計算しない。**
 * 2か所で数えると、どちらが効いているのか読めなくなる（I-2 と同じ理由）。
 *
 * ## 1日1本だけ
 *
 * 溜まっていても、**その日に積むのは1本。** まとめて積むと、
 * AIの呼び出しが同時に走って費用の上限（SPEC 12）に一度で当たる。
 * 遅れは次の公開日に取り戻せる。
 */

/** 記事1本を積む冪等キー。**記事IDそのもの**なので二度は積まれない */
function articleJobKey(contentItemId: string): string {
  return `ARTICLE_GENERATION:${contentItemId}`;
}

export interface ArticleScheduleResult {
  /** 対象になったブログの数（公開日でないブログは含まない） */
  blogs: number;
  /** 新しく積んだ記事の本数 */
  queued: number;
  /** 積めなかったブログの数。**0でないことが分かるように返す** */
  failed: number;
}

/**
 * 今日が公開する曜日か（JSTで見る）。
 *
 * **UTCで曜日を見ると、日本の朝が前日として判定される**（F-3b と同じ）。
 */
function isPublishDay(publishWeekdays: readonly number[], now: Date): boolean {
  // JSTの暦日をそのままUTCの日付として読めば、曜日はJSTのものになる
  const jstDay = new Date(`${todayInJst(now)}T00:00:00.000Z`).getUTCDay();

  return publishWeekdays.includes(jstDay);
}

/**
 * 利用者の全ブログについて、今日ぶんの記事生成を積む。
 *
 * **`ACTIVE` のブログだけ。** 準備中（`SETUP`）・停止中・閉じたブログの
 * 記事を書かない。
 *
 * **`launch_date` が無いブログは対象にしない** — 週の起点が決まって
 * おらず、「いま何週目か」を推測で決めると**構成表の順序が壊れる。**
 *
 * **1ブログの失敗で残りを止めない。**
 */
export async function enqueueArticleGenerationForUser(
  userId: string,
  params: { now?: Date | undefined } = {},
): Promise<ArticleScheduleResult> {
  const now = params.now ?? new Date();
  const today = todayInJst(now);

  const blogs = (await listBlogsForUser(userId)).flatMap((blog) =>
    blog.status === 'ACTIVE' &&
    blog.launchDate !== null &&
    isPublishDay(blog.publishWeekdays, now)
      ? [{ id: blog.id, launchDate: blog.launchDate }]
      : [],
  );

  const result: ArticleScheduleResult = {
    blogs: blogs.length,
    queued: 0,
    failed: 0,
  };

  for (const blog of blogs) {
    try {
      // **公開開始日を1週目とする**（`launch_date`。C-9）
      const week = jstWeekNumber(toJstDate(blog.launchDate), today);

      const targets = await listGenerationTargetsForUser({
        userId,
        blogId: blog.id,
        upToWeek: week,
      });

      const next = targets[0];

      if (next === undefined) {
        continue;
      }

      const enqueued = await enqueueJob({
        jobType: 'ARTICLE_GENERATION',
        idempotencyKey: articleJobKey(next.id),
        input: {},
        userId,
        blogId: blog.id,
        // **記事IDは `target_id` に入れる**（`input` からは取らない。E-10）
        targetId: next.id,
      });

      if (enqueued.created) {
        result.queued += 1;
      }
    } catch (error) {
      // **ブログIDだけを残す。** 中身は出さない（SPEC 14.2）
      result.failed += 1;
      logger.error('記事生成を積めなかった', {
        blogId: blog.id,
        cause: error,
      });
    }
  }

  return result;
}
