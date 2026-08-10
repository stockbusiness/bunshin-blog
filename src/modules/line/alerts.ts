/**
 * 緊急通知の中身（TASKS H-3、SPEC 8.3）。
 *
 * 完了条件は「**接続切れ・リンク切れ・案件終了が緊急通知される**」。
 *
 * ## 別枠であることは F-3 が用意した
 *
 * SPEC 8.3 の「緊急通知は別枠」は、**`approvals` の行を作らないこと**で
 * 満たしている。ここはその枠に何を流すかを決める。
 *
 * ## 同じことを毎日言わない
 *
 * 接続が切れたままなら、検出は毎回当たる。**毎回送ると、通知が
 * 「読まなくてよいもの」になる。**
 *
 * 通知はジョブとして積み、**冪等キーに「ブログ・種類・JSTの日付」を
 * 入れる**（C-4）。同じ日の同じ指摘は1回しか積まれない。
 * 直っていなければ翌日また届く — **直すまで思い出させる**のは正しい。
 */

import { jstDayRange, todayInJst } from '@/lib/datetime';
import { checkOfferLinksForUser, listOffersForUser } from '@/modules/affiliate';
import { listBlogsForUser } from '@/modules/blogs';
import { findWordpressConnectionForUser } from '@/modules/wordpress';
import type { EmergencyKind } from './notify';

export interface BlogAlert {
  blogId: string;
  blogName: string;
  kind: EmergencyKind;
  detail: string;
}

/**
 * WordPress の接続が切れているか。
 *
 * **未接続と切断を分けない。** どちらも「いま投稿できない」で、
 * モニターがすることは同じ（接続し直す）。
 *
 * ただし**一度も接続していないブログは知らせない** — 準備中の
 * ブログに毎日「接続が切れています」と送ることになる。
 */
export function judgeConnectionAlert(
  connection: { connectionStatus: string; lastTestedAt: Date | null } | null,
): string | null {
  if (connection === null) {
    return null;
  }

  // **一度も試していないブログは対象外**（準備中とみなす）
  if (connection.lastTestedAt === null) {
    return null;
  }

  if (connection.connectionStatus === 'CONNECTED') {
    return null;
  }

  return 'WordPressへ投稿できません。設定から接続し直してください。';
}

export interface CollectAlertsDeps {
  /** 差し替え用。既定は実HTTP（C-7 の `safeFetch`） */
  checkLinks?: typeof checkOfferLinksForUser | undefined;
}

/**
 * 利用者のブログを見て、知らせるべきことを集める。
 *
 * **`CLOSED` のブログは見ない**（`listBlogsForUser` の既定）。
 * 閉じたブログの接続が切れていても、直す理由が無い。
 */
export async function collectAlertsForUser(
  userId: string,
  deps: CollectAlertsDeps = {},
): Promise<BlogAlert[]> {
  const blogs = await listBlogsForUser(userId);
  const checkLinks = deps.checkLinks ?? checkOfferLinksForUser;
  const alerts: BlogAlert[] = [];

  for (const blog of blogs) {
    const params = { userId, blogId: blog.id };

    const connection = await findWordpressConnectionForUser(params);
    const connectionDetail = judgeConnectionAlert(connection);

    if (connectionDetail !== null) {
      alerts.push({
        blogId: blog.id,
        blogName: blog.name,
        kind: 'WORDPRESS_DISCONNECTED',
        detail: connectionDetail,
      });
    }

    // **終了した案件が記事から参照されている場合だけ知らせる。**
    // 登録しただけで終了した案件は、直す作業が無い
    const ended = await listOffersForUser(params, { status: 'ENDED' });

    if (ended.length > 0) {
      alerts.push({
        blogId: blog.id,
        blogName: blog.name,
        kind: 'OFFER_ENDED',
        detail: `終了した案件が${ended.length}件あります。差し替えをご検討ください。`,
      });
    }

    const links = await checkLinks(params);
    const gone = links.filter((link) => link.health === 'GONE');

    if (gone.length > 0) {
      alerts.push({
        blogId: blog.id,
        blogName: blog.name,
        kind: 'LINK_BROKEN',
        // **どの案件かを書く。** 「リンクが切れています」だけでは探せない
        detail: `リンクが切れています：${gone
          .map((link) => link.offerName)
          .join('、')}`,
      });
    }
  }

  return alerts;
}

/**
 * 通知の冪等キー（C-4）。
 *
 * **ブログ・種類・JSTの日付**で1つ。同じ日の同じ指摘は1回だけ積まれる。
 * 日付をJSTにするのは、UTCだと日本の1日が2日にまたがり、
 * 夜の指摘と翌朝の指摘が別扱いになるため（F-3 と同じ理由）。
 */
export function alertIdempotencyKey(params: {
  alert: BlogAlert;
  now: Date;
}): string {
  const date = todayInJst(params.now);

  return `LINE_NOTIFY:${params.alert.blogId}:${params.alert.kind}:${date}`;
}

/** その日の範囲（重複の確認に使う） */
export function alertDayRange(now: Date): { start: Date; endExclusive: Date } {
  return jstDayRange(todayInJst(now));
}
