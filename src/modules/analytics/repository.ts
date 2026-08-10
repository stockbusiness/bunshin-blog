/**
 * `link_clicks` テーブルへのアクセス（TASKS D-8、SPEC 5.14）。
 *
 * **このモジュールだけが `link_clicks` を触る**（MODULE_RULES 1）。
 *
 * **`userId` を伴わない。** クリックするのは記事の読者で、ログインしていない。
 * 所有権の判定に使える情報がそもそも無く、`...ForUser` の形にならない。
 * 代わりに**書き込みしかできない**入口にしてある（読み出しは G-2 の集計）。
 */

import { prisma } from '@/lib/db';
import { isAiReferralHost, resolveAiReferralDomains } from './ai-referral';
import { hashUserAgent, parseReferrerHost } from './click';
import type { AppLinkClick, RecordClickInput } from './types';

/**
 * クリックを記録する（完了条件「`REDIRECT` の案件でクリックが記録される」）。
 *
 * **AI検索経由かをここで判別する**（G-4、SPEC 11.4）。`referrer_host` は
 * そのまま残すので、**対象ドメインを足したあとに過去のクリックも
 * 数え直せる**（`recountAiReferrals`）。
 */
export async function recordLinkClick(
  input: RecordClickInput,
): Promise<AppLinkClick> {
  const host = parseReferrerHost(input.referrer);

  const row = await prisma.linkClick.create({
    data: {
      affiliateLinkId: input.affiliateLinkId,
      referrerHost: host,
      // **取れなかったものは `false`。** `Referer` の欠落は異常ではなく、
      // 「判別できなかった」だけ（SPEC 11.4）
      isAiReferral: isAiReferralHost(host, resolveAiReferralDomains()),
      userAgentHash: hashUserAgent(input.userAgent),
    },
    select: {
      id: true,
      affiliateLinkId: true,
      referrerHost: true,
      isAiReferral: true,
      userAgentHash: true,
      clickedAt: true,
    },
  });

  return row;
}

/** リンクごとのクリック数を数える（G-2 の集計が使う） */
export async function countLinkClicks(
  affiliateLinkId: string,
): Promise<number> {
  return prisma.linkClick.count({ where: { affiliateLinkId } });
}

/**
 * 保存済みのクリックを数え直す（G-4）。
 *
 * **対象ドメインを足したあとに走らせる。** `referrer_host` を残してあるので
 * （D-8）、判別だけをやり直せる。
 *
 * **`referrer_host` は書き換えない。** 元の値であり、判別の結果ではない。
 *
 * @returns 判別が変わった件数
 */
export async function recountAiReferrals(
  domains: readonly string[] = resolveAiReferralDomains(),
): Promise<number> {
  const rows = await prisma.linkClick.findMany({
    select: { id: true, referrerHost: true, isAiReferral: true },
  });

  let changed = 0;

  for (const row of rows) {
    const expected = isAiReferralHost(row.referrerHost, domains);

    if (expected === row.isAiReferral) {
      continue;
    }

    await prisma.linkClick.update({
      where: { id: row.id },
      data: { isAiReferral: expected },
    });

    changed += 1;
  }

  return changed;
}

/** AI検索経由のクリック数（SPEC 11.4「判別可能なAIサービス経由流入数」） */
export async function countAiReferrals(
  affiliateLinkIds: readonly string[],
): Promise<number> {
  if (affiliateLinkIds.length === 0) {
    return 0;
  }

  return prisma.linkClick.count({
    where: {
      affiliateLinkId: { in: [...affiliateLinkIds] },
      isAiReferral: true,
    },
  });
}
