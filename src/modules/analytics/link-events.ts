import { prisma } from '@/lib/db';
import { isAiReferralHost, resolveAiReferralDomains } from './ai-referral';
import type { ParsedLinkEvent } from './link-event-payload';

/**
 * 受信したクリックを保存する（TASKS D-12、Q-001 の再決定）。
 *
 * **このモジュールだけが `link_clicks` を触る**（MODULE_RULES 1）。
 *
 * `userId` を伴わない理由は `recordLinkClick`（D-8）と同じ — 叩くのは
 * 各ブログのWordPressで、セッションが無い。**どのブログかはトークンが
 * 決めており**（`findBlogIdByLinkEventToken`）、ここへ来る時点で
 * `code` の解決も済んでいる。
 */

/** 解決済みの1件。案件のリンクかバナーの**どちらか片方**が入る */
export interface ResolvedLinkEvent extends ParsedLinkEvent {
  affiliateLinkId: string | null;
  bannerId: string | null;
}

export interface RecordLinkEventsResult {
  /** 実際に増えた行数 */
  inserted: number;
  /** 既に入っていた件数（再送）。**黙って捨てない** */
  duplicated: number;
}

/**
 * まとめて保存する。
 *
 * **再送は落とす。** `link_clicks.event_id` が unique なので、
 * `skipDuplicates` で2回目が入らない（D-12-schema-2）。
 * 「入っているか調べてから入れる」にしないのは、同じ電文が同時に
 * 2回届くと両方とも「まだ無い」と判定して通るため。
 *
 * **AI検索経由かはここで判別する**（G-4、SPEC 11.4）。送信元に判別させると、
 * 対象ドメインの一覧が30ブログへ散らばり、後から足せなくなる。
 */
export async function recordLinkEvents(
  events: readonly ResolvedLinkEvent[],
): Promise<RecordLinkEventsResult> {
  if (events.length === 0) {
    return { inserted: 0, duplicated: 0 };
  }

  const domains = resolveAiReferralDomains();

  const result = await prisma.linkClick.createMany({
    data: events.map((event) => ({
      eventId: event.eventId,
      affiliateLinkId: event.affiliateLinkId,
      bannerId: event.bannerId,
      referrerHost: event.referrerHost,
      isAiReferral: isAiReferralHost(event.referrerHost, domains),
      userAgentHash: event.userAgentHash,
      clickedAt: event.clickedAt,
    })),
    skipDuplicates: true,
  });

  return {
    inserted: result.count,
    duplicated: events.length - result.count,
  };
}
