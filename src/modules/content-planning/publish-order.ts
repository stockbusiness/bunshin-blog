/**
 * 公開順序の付与（TASKS E-9、SPEC 9.2.7・2.2）。
 *
 * ```
 * 1〜2週目：収益記事を全本公開
 * 3週目以降：集客記事を週4本、収益記事に近いものから
 * 週4本を超えて公開する処理を実装してはならない
 * ```
 *
 * ## 上限はブログの設定を使う
 *
 * SPEC 2.2 の4本は**絶対の上限**で、ブログごとの `weeklyPublishCap`
 * （1〜4本。B-5）はそれ以下。**低いほうを使う。**
 *
 * 上限が4本より低いと、収益記事が2週で収まらないことがある（案件3件なら
 * 7本）。そのときは**3週目以降にもかかる** — SPEC 9.2.7 の「1〜2週目」は
 * 週4本を前提にした書き方で、**守るべきは「収益記事が先行する」ほう**
 * （完了条件）。上限を破って2週へ詰め込むのは SPEC 2.2 に反する。
 *
 * ## 「収益記事に近いものから」
 *
 * 集客記事は**リンク先の収益記事が公開される順**に並べる。先に出る
 * 収益記事へ流す記事を先に出すほうが、流入が早く効く。
 *
 * DBも外部も触らない純粋な処理。
 */

import { invalidPublishOrderError } from './errors';
import type { ContentType } from './step4';

/** 1週あたりの絶対上限（SPEC 2.2） */
export const ABSOLUTE_WEEKLY_CAP = 4;

/** 収益記事に充てる週（SPEC 9.2.7） */
export const REVENUE_WEEKS = 2;

export interface OrderableItem {
  id: string;
  contentType: ContentType;
  /** 構成表の並び。収益記事の順序はこれで決まる */
  sequenceNo: number;
  /** 集客記事のリンク先。収益記事なら空 */
  outboundLinkItemIds: readonly string[];
}

export interface PublishSlot {
  itemId: string;
  /** 1から始まる通し番号 */
  publishPriority: number;
  /** 1から始まる週 */
  plannedPublishWeek: number;
}

/** 収益記事か（`AFFILIATE` と比較記事） */
function isRevenue(item: OrderableItem): boolean {
  return item.contentType === 'AFFILIATE' || item.contentType === 'COMPARISON';
}

/**
 * 公開順序と週を割り当てる（完了条件「収益記事が先行し、集客記事が
 * 週4本を超えない」）。
 *
 * @throws {AppError} 上限が1〜4の範囲にない
 */
export function assignPublishOrder(params: {
  items: readonly OrderableItem[];
  /** ブログの週あたり公開本数（1〜4） */
  weeklyCap: number;
}): PublishSlot[] {
  if (
    !Number.isInteger(params.weeklyCap) ||
    params.weeklyCap < 1 ||
    params.weeklyCap > ABSOLUTE_WEEKLY_CAP
  ) {
    throw invalidPublishOrderError(
      `週あたりの公開本数は1〜${ABSOLUTE_WEEKLY_CAP}で指定してください`,
    );
  }

  const revenue = params.items
    .filter(isRevenue)
    .toSorted((a, b) => a.sequenceNo - b.sequenceNo);

  // **収益記事の公開順を先に決める。** 集客記事の並びはこれに従う
  const revenueRank = new Map(revenue.map((item, index) => [item.id, index]));

  const traffic = params.items
    .filter((item) => !isRevenue(item))
    .toSorted((a, b) => {
      const rankA = Math.min(
        ...a.outboundLinkItemIds.map(
          (id) => revenueRank.get(id) ?? Number.MAX_SAFE_INTEGER,
        ),
        Number.MAX_SAFE_INTEGER,
      );
      const rankB = Math.min(
        ...b.outboundLinkItemIds.map(
          (id) => revenueRank.get(id) ?? Number.MAX_SAFE_INTEGER,
        ),
        Number.MAX_SAFE_INTEGER,
      );

      // **同じ収益記事へ流すものは構成表の順。** 呼ぶたびに入れ替わらない
      return rankA - rankB || a.sequenceNo - b.sequenceNo;
    });

  // **収益記事が先。** これが完了条件の前半
  const ordered = [...revenue, ...traffic];

  return ordered.map((item, index) => ({
    itemId: item.id,
    publishPriority: index + 1,
    // **上限で割って週を出す。** 超える処理を書かない（SPEC 2.2）
    plannedPublishWeek: Math.floor(index / params.weeklyCap) + 1,
  }));
}

/**
 * 収益記事が2週に収まるか（SPEC 9.2.7 の想定どおりか）。
 *
 * **収まらないことを失敗にしない。** ブログの上限が低ければ起きる
 * （案件3件なら収益7本で、週2本だと4週かかる）。守るべきは
 * 「収益記事が先行する」ほうで、これは判断の材料として返す。
 */
export function revenueFitsInInitialWeeks(params: {
  revenueCount: number;
  weeklyCap: number;
}): boolean {
  return params.revenueCount <= params.weeklyCap * REVENUE_WEEKS;
}
