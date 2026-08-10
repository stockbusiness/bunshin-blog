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
 * ## 判定するだけで、状態を書かない
 *
 * `affiliate_offers` に「切れている」を持つ列が無い。**持たせるかは
 * 未解決**（Q-029）。いまは確認した結果をその場で返すだけで、
 * 通知の重複は呼び出し側（H-3）がジョブの冪等キーで防ぐ。
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
    select: { id: true, name: true, landingPageUrl: true },
  });

  const results: OfferLinkCheck[] = [];

  for (const offer of offers) {
    results.push({
      offerId: offer.id,
      offerName: offer.name,
      url: offer.landingPageUrl,
      ...(await check(fetchFn, offer.landingPageUrl)),
    });
  }

  return results;
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
