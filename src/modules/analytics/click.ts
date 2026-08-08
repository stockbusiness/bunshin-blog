/**
 * クリックの記録に使う値の整形（TASKS D-8、SPEC 5.14・11.4）。
 *
 * DBもネットワークも触らない純粋な処理。
 *
 * ## 生のUAとURLを保存しない
 *
 * `link_clicks` に残すのは**ホスト名**と**UAのハッシュ**だけ。
 *
 * - **参照元のURL全体を保存しない。** 記事のURLにはクエリが付くことがあり、
 *   利用者が入力した値が混ざりうる
 * - **UAは戻せない形にする。** 集計に要るのは「同じ端末からの連打か」で
 *   あって、UAそのものではない
 */

import { createHash } from 'node:crypto';

/** ホスト名の上限。異常に長い値をDBへ入れない */
export const REFERRER_HOST_MAX_LENGTH = 255;

/**
 * `Referer` からホスト名を取り出す。
 *
 * **取れなければ `null`。** `Referer` は付かないことがあり（SPEC 11.4
 * 「referrerが欠落する場合があるため、完全値として扱わない」）、
 * 欠落は異常ではない。
 */
export function parseReferrerHost(
  referrer: string | null | undefined,
): string | null {
  if (referrer === null || referrer === undefined || referrer.trim() === '') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }

  // `javascript:` などにはホストが無い
  if (url.hostname === '') {
    return null;
  }

  const host = url.hostname.toLowerCase();

  return host.length > REFERRER_HOST_MAX_LENGTH ? null : host;
}

/**
 * UAをハッシュにする。
 *
 * **戻せない形にする。** 集計に要るのは「同じ端末からの連打か」であって、
 * UAそのものではない。
 *
 * 塩を使わない。UAは端末を特定する値ではなく、**同じUAが同じハッシュに
 * なること自体が目的**（連打の判定に使う）。塩を入れると再起動のたびに
 * 別のハッシュになり、用をなさない。
 */
export function hashUserAgent(
  userAgent: string | null | undefined,
): string | null {
  if (
    userAgent === null ||
    userAgent === undefined ||
    userAgent.trim() === ''
  ) {
    return null;
  }

  return createHash('sha256').update(userAgent, 'utf8').digest('hex');
}
