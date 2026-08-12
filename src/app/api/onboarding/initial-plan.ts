import { logger } from '@/lib/logger';
import { listOffersForUser } from '@/modules/affiliate';
import { listBlogsForUser } from '@/modules/blogs';
import { enqueueJob } from '@/modules/jobs';

/**
 * 初期構成表の積み込み（TASKS I-10、OPEN_QUESTIONS Q-039 の (a)）。
 *
 * ## なぜ必要だったのか
 *
 * **`PLAN_GENERATION` を積む経路がどこにも無かった**（棚卸し・2026-08-12）。
 * ハンドラは E-9 で登録済みで、手で積めば動く。**構成表が無いので、
 * I-4 が積む記事生成も対象を1件も見つけられない。**
 *
 * ## なぜオンボーディングの完了時か（Q-039）
 *
 * **入力が揃っているのがここだけ。** `PLAN_GENERATION` は
 * `genreName` と `adoptedOfferIds` を要る（E-9）。どちらも
 * **モニターがオンボーディングで決めるもの**で、日次の積み込み（I-1）が
 * 推測で埋めてよい値ではない。
 *
 * **案件を採用した時点にしない。** 案件は運用中に足されるもので、
 * そのたびに30本の構成表を作ると費用の上限（SPEC 12）に当たる。
 *
 * ## ブログごとに見る
 *
 * オンボーディングの完了は **1ブログでも条件を満たせば済み**（H-2a。
 * 3件すべてを求めると、1ブログで始める人が永久に終わらない）。
 * つまり**完了した時点で、まだ整っていないブログがありうる。**
 *
 * **整っていないブログを飛ばす。** 推測で埋めると、ジャンルの無いブログの
 * 構成表が「何について書くか決まっていない」まま作られる。
 *
 * ## 一度だけ
 *
 * 冪等キーは `PLAN_GENERATION:<ブログ>:INITIAL`。**この画面は
 * オンボーディング中ずっと開かれる**ので、積む条件が揃った後は
 * 毎回この関数を通る。**作り直しはここではしない**（別の経路。未実装）。
 */

/**
 * 構成表に使ってよい案件の状態。
 *
 * **`DRAFT` を含める。** 登録した直後の状態で（`affiliate_offers.status`
 * の既定）、オンボーディングには**採用を別に示す手段が無い。**
 * 登録したのに使われないと、段8 が何のための作業か分からなくなる。
 *
 * **`PAUSED` `ENDED` `NEEDS_REVIEW` は含めない。** どれも
 * 「いまは使わない」という**明示の意思表示**である。
 */
const USABLE_OFFER_STATUSES = new Set(['DRAFT', 'ACTIVE']);

export interface InitialPlanResult {
  /** 新しく積んだブログの数 */
  queued: number;
  /** まだ整っていないので飛ばしたブログの数 */
  skipped: number;
  /** 積めなかったブログの数。**0でないことが分かるように返す** */
  failed: number;
}

/**
 * 整っているブログの初期構成表を積む。
 *
 * **WordPress の接続は条件にしない。** 構成表を作るのに WordPress は
 * 要らない（要るのは投稿のとき。F-7）。条件にすると、**書くものが
 * 決まっているのに、繋ぐまで何も始まらない。**
 *
 * **1ブログの失敗で残りを止めない。**
 */
export async function enqueueInitialPlansForUser(
  userId: string,
): Promise<InitialPlanResult> {
  const blogs = await listBlogsForUser(userId);

  const result: InitialPlanResult = { queued: 0, skipped: 0, failed: 0 };

  for (const blog of blogs) {
    // **ジャンルが無ければ積めない。** `genreName` が入力に要る（E-9）
    if (blog.genre === null) {
      result.skipped += 1;

      continue;
    }

    try {
      const offers = (
        await listOffersForUser({ userId, blogId: blog.id })
      ).filter((offer) => USABLE_OFFER_STATUSES.has(offer.status));

      // **案件が1件も無ければ積まない。** 収益記事が作れず、
      // 集客記事の誘導先も無い構成表になる（SPEC 9.2）
      if (offers.length === 0) {
        result.skipped += 1;

        continue;
      }

      const enqueued = await enqueueJob({
        jobType: 'PLAN_GENERATION',
        idempotencyKey: `PLAN_GENERATION:${blog.id}:INITIAL`,
        input: {
          genreName: blog.genre.name,
          adoptedOfferIds: offers.map((offer) => offer.id),
        },
        userId,
        blogId: blog.id,
      });

      if (enqueued.created) {
        result.queued += 1;
      }
    } catch (error) {
      // **ブログIDだけを残す。** 中身は出さない（SPEC 14.2）
      result.failed += 1;
      logger.error('初期構成表を積めなかった', {
        blogId: blog.id,
        cause: error,
      });
    }
  }

  return result;
}
