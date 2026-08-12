/**
 * LINE Webhook の署名検証（TASKS D-7b、SPEC 14.3）。
 *
 * Webhook の受け口は**認証の無い入口**で、URLさえ知っていれば誰でも叩ける。
 * 署名を確かめないと、**他人になりすまして `persona_facts` に事実を
 * 書き込める**（分身の記憶が外から汚される）。
 *
 * LINE は本文（生バイト列）の HMAC-SHA256 を base64 にしたものを
 * `x-line-signature` に載せてくる。
 *
 * ## 生の本文で計算する
 *
 * **JSONを読み直して組み立て直すと一致しない。** 空白や鍵の順序が
 * 変わるためで、`request.text()` で受けた文字列をそのまま使う。
 *
 * ## 比較は時間を一定にする
 *
 * `===` で比べると、**先頭から何文字一致したかが応答時間に出る。**
 * 1文字ずつ試せば署名を組み立てられてしまうため `timingSafeEqual` を使う。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 署名が正しいかを返す。
 *
 * **理由を返さない。** 「署名が無い」「形が違う」「合わない」を呼び出し側が
 * 出し分けると、総当たりの手がかりになる。
 *
 * @param channelSecret Messaging API のチャネルシークレット。**秘密**
 */
export function verifyLineSignature(params: {
  body: string;
  signature: string | null;
  channelSecret: string;
}): boolean {
  const { body, signature, channelSecret } = params;

  if (signature === null || signature === '' || channelSecret === '') {
    return false;
  }

  const expected = createHmac('sha256', channelSecret).update(body).digest();

  let received: Buffer;

  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // **長さが違うと `timingSafeEqual` は例外を投げる。** 先に見る
  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(received, expected);
}

/**
 * チャネルシークレットを読む。
 *
 * **足りない変数名だけを返す。値は返さない**（SPEC 14.2。`readLineConfig`
 * と同じ形）。
 */
export function readLineChannelSecret(
  source: Record<string, string | undefined>,
): { ok: true; channelSecret: string } | { ok: false; missing: string[] } {
  const secret = source['LINE_CHANNEL_SECRET']?.trim() ?? '';

  if (secret === '') {
    return { ok: false, missing: ['LINE_CHANNEL_SECRET'] };
  }

  return { ok: true, channelSecret: secret };
}
