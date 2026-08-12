/**
 * リンク切れの確認（TASKS H-3、SPEC 4「リンク切れ確認」ジョブ）。
 *
 * **必ず `safeFetch` を通す**（C-7、SPEC 14.3）。`fetch` を直接呼ばない。
 * 案件のURLは利用者が入力した値で、内部のアドレスを指しうる。
 *
 * ## 落ちたことと切れたことを分ける
 *
 * 一時的な失敗（タイムアウト・5xx）と、**恒久的に消えた**（404・410）は
 * 別物である。前者で通知すると、ASPのメンテナンスのたびに緊急通知が飛ぶ。
 *
 * ## 結果を残す（H-3b）
 *
 * 確認のたびに `affiliate_offers.link_checked_at` / `link_broken_at` を
 * 書く（Q-029）。**通知の重複はいまも呼び出し側（H-3）がジョブの
 * 冪等キーで防ぐ** — 列は画面のためにある。
 *
 * | 結果 | `link_checked_at` | `link_broken_at` |
 * |---|---|---|
 * | `OK` | 入れる | **`NULL` に戻す**（直った） |
 * | `GONE` | 入れる | **まだ無いときだけ入れる**（いつからかを保つ） |
 * | `UNAVAILABLE` | **触らない** | **触らない** |
 *
 * **`UNAVAILABLE` で `link_checked_at` を動かさない。** 届かなかったのは
 * 「確認した」ではなく「分からなかった」で、時刻を入れると
 * **画面には「今日確認済み」と出る。** 分からないことを「問題なし」に
 * 化けさせない。1週間届かないままなら、確認時刻は1週間前のまま出る。
 *
 * **切れている間 `link_broken_at` を動かさない。** 動かすと
 * 「いつからか」が毎回今日になり、モニターが直す優先度を決められない。
 */

import { isHttpFetchError, safeFetch } from '@/lib/http';
import { prisma } from '@/lib/db';
import { requireBlogForUser } from '@/modules/blogs';

/** リンクの状態 */
export type LinkHealth =
  /** 生きている */
  | 'OK'
  /** **恒久的に消えた**（404・410）。通知の対象 */
  | 'GONE'
  /** 一時的に届かない。**通知しない** */
  | 'UNAVAILABLE';

export interface OfferLinkCheck {
  offerId: string;
  offerName: string;
  url: string;
  health: LinkHealth;
  status: number | null;
}

/**
 * HTTPの応答からリンクの状態を決める。
 *
 * **4xx のうち 404 と 410 だけを「消えた」とする。** 401・403 は
 * ASPが機械的なアクセスを弾いているだけのことが多く、
 * 人が開けばリンクは生きている。
 */
export function judgeLinkHealth(status: number): LinkHealth {
  if (status === 404 || status === 410) {
    return 'GONE';
  }

  if (status >= 200 && status < 400) {
    return 'OK';
  }

  return 'UNAVAILABLE';
}

export interface CheckOfferLinksDeps {
  /** 差し替え用。既定は `safeFetch`（C-7） */
  fetchFn?: typeof safeFetch;
  /** 試験のために固定する。既定は現在時刻 */
  now?: Date | undefined;
}

/**
 * ブログの案件のリンクを確かめる。
 *
 * **`ACTIVE` の案件だけを見る。** 下書きや終了した案件のリンクが
 * 切れていても、記事からは参照されない。
 *
 * 確かめるのは `landing_page_url`。**`affiliate_url` は踏むと
 * クリックとして計上されうる** ため、確認では叩かない。
 */
export async function checkOfferLinksForUser(
  params: { userId: string; blogId: string },
  deps: CheckOfferLinksDeps = {},
): Promise<OfferLinkCheck[]> {
  const blog = await requireBlogForUser(params);
  const fetchFn = deps.fetchFn ?? safeFetch;

  const offers = await prisma.affiliateOffer.findMany({
    where: { blogId: blog.id, status: 'ACTIVE' },
    // **`link_broken_at` を読んでから書く。** 既に切れているなら
    // 時刻を動かさないため（いつからかを保つ）
    select: {
      id: true,
      name: true,
      landingPageUrl: true,
      linkBrokenAt: true,
    },
  });

  const now = deps.now ?? new Date();
  const results: OfferLinkCheck[] = [];

  for (const offer of offers) {
    const outcome = await check(fetchFn, offer.landingPageUrl);

    await saveLinkState({ offer, health: outcome.health, now });

    results.push({
      offerId: offer.id,
      offerName: offer.name,
      url: offer.landingPageUrl,
      ...outcome,
    });
  }

  return results;
}

/**
 * 確認の結果を書く（H-3b）。
 *
 * **`UNAVAILABLE` では何も書かない。** 届かなかったのは「分からなかった」
 * であって「確認した」ではない。
 */
async function saveLinkState(params: {
  offer: { id: string; linkBrokenAt: Date | null };
  health: LinkHealth;
  now: Date;
}): Promise<void> {
  if (params.health === 'UNAVAILABLE') {
    return;
  }

  await prisma.affiliateOffer.update({
    where: { id: params.offer.id },
    data: {
      linkCheckedAt: params.now,
      linkBrokenAt:
        params.health === 'OK'
          ? // 直った
            null
          : // **既にあれば動かさない。** いつからかを保つ
            (params.offer.linkBrokenAt ?? params.now),
    },
  });
}

async function check(
  fetchFn: typeof safeFetch,
  url: string,
): Promise<{ health: LinkHealth; status: number | null }> {
  try {
    const response = await fetchFn(url);

    return {
      health: judgeLinkHealth(response.status),
      status: response.status,
    };
  } catch (error) {
    // **届かなかったことを「消えた」にしない。** 宛先が拒否された場合も同じ
    if (isHttpFetchError(error)) {
      return { health: 'UNAVAILABLE', status: null };
    }

    throw error;
  }
}

/** 画面に出す「いま切れているリンク」1件（H-3b） */
export interface BrokenOfferLink {
  offerId: string;
  offerName: string;
  /** **いつから切れているか。** 直す優先度はここで決まる */
  brokenAt: Date;
}

/**
 * いま切れているリンクを一覧する（H-3b、SPEC 6.1「エラー」）。
 *
 * **`ACTIVE` の案件だけ。** 終了した案件のリンクが切れていても、
 * 記事からは参照されない（確認しているのも `ACTIVE` だけ）。
 *
 * **古い順に返す。** 長く切れているものほど先に直す。
 */
export async function listBrokenOfferLinksForUser(params: {
  userId: string;
  blogId: string;
}): Promise<BrokenOfferLink[]> {
  const blog = await requireBlogForUser(params);

  const rows = await prisma.affiliateOffer.findMany({
    where: { blogId: blog.id, status: 'ACTIVE', linkBrokenAt: { not: null } },
    orderBy: [{ linkBrokenAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, linkBrokenAt: true },
  });

  return rows.flatMap((row) =>
    row.linkBrokenAt === null
      ? []
      : [
          {
            offerId: row.id,
            offerName: row.name,
            brokenAt: row.linkBrokenAt,
          },
        ],
  );
}
