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
import { hashUserAgent, parseReferrerHost } from './click';
import type { AppLinkClick, RecordClickInput } from './types';

/**
 * クリックを記録する（完了条件「`REDIRECT` の案件でクリックが記録される」）。
 *
 * **`is_ai_referral` は常に `false` で入る。** 判別は G-4 の担当で、
 * 対象ドメインを設定ファイルで追加できる形にする。**`referrer_host` を
 * 残してあるので後から数え直せる。**
 */
export async function recordLinkClick(
  input: RecordClickInput,
): Promise<AppLinkClick> {
  const row = await prisma.linkClick.create({
    data: {
      affiliateLinkId: input.affiliateLinkId,
      referrerHost: parseReferrerHost(input.referrer),
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
