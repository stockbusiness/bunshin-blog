import { logger } from '@/lib/logger';
import { readLineChannelSecret, verifyLineSignature } from '@/lib/line';
import { buildIdempotencyKey, enqueueJob } from '@/modules/jobs';
import { parseLineWebhook, type LineTextReply } from '@/modules/line';
import { getRuntimeEnv } from '@/modules/settings';
import { findByLineUserId } from '@/modules/users';

/**
 * `POST /api/line/webhook` LINE返信の受け口（TASKS D-7b、SPEC 8.4）。
 *
 * ## 認証は署名
 *
 * **URLさえ知っていれば誰でも叩ける入口。** 署名を確かめないと、
 * 他人になりすまして**分身の記憶を外から書き込める。**
 * `x-line-signature` を生の本文で検証する（`verifyLineSignature`）。
 *
 * ## その場で保存しない
 *
 * 受けたらジョブに積んで、すぐ 200 を返す。**LINE は応答が遅いと
 * 時間切れと見なして同じ電文を再送する**ので、分類も保存もここではしない。
 *
 * MODULE_RULES 3 のとおり、`line → approvals` の循環を避けるためにも
 * 受信はジョブに載せる。
 *
 * ## 200 を返す条件
 *
 * **署名が合っていれば 200。** 中身が読めなくても、知らないユーザーでも
 * 200 を返す。ここで 4xx を返すと、**LINE がその電文を再送し続ける。**
 *
 * 署名が合わないときだけ 401。**理由は分けない**（総当たりの手がかり）。
 *
 * ## 再送で二重に取り込まない
 *
 * `webhookEventId` は再送でも同じ値なので、そのままジョブの冪等キーにする
 * （`link_clicks.event_id` と同じ形）。同じ電文が2回届いても
 * ジョブは1つしか積まれない。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 積んだジョブの数を数える。**中身は数えるだけで残さない** */
async function enqueueReply(reply: LineTextReply): Promise<boolean> {
  // **`line_user_id` からユーザーを引く。** 見つからなければ何もしない —
  // 友だち追加しただけで未登録の人からもメッセージは届く
  const user = await findByLineUserId(reply.lineUserId);

  if (user === null) {
    return false;
  }

  await enqueueJob({
    jobType: 'LINE_REPLY',
    userId: user.id,
    // **再送でも同じ鍵。** 同じ返信からジョブが2つ積まれない
    idempotencyKey: buildIdempotencyKey('LINE_REPLY', reply.webhookEventId),
    input: {
      text: reply.text,
      eventId: reply.webhookEventId,
      receivedAt: reply.timestamp.toISOString(),
    },
  });

  return true;
}

export async function POST(request: Request): Promise<Response> {
  // **生の本文で署名を計算する。** JSONを読み直して組み立て直すと、
  // 空白や鍵の順序が変わって一致しない
  const body = await request.text();

  const env = await getRuntimeEnv();
  const secret = readLineChannelSecret({ ...env });

  if (!secret.ok) {
    // **設定が無いときに素通りさせない。** 素通りさせると、
    // 設定を入れ忘れたまま誰でも書き込める状態になる
    logger.error('LINE Webhook の設定が無い', { missing: secret.missing });

    return Response.json(
      { error: { message: '受け付けられません' } },
      { status: 401 },
    );
  }

  if (
    !verifyLineSignature({
      body,
      signature: request.headers.get('x-line-signature'),
      channelSecret: secret.channelSecret,
    })
  ) {
    // **理由を分けない**（「署名が無い」と「合わない」を出し分けない）
    return Response.json(
      { error: { message: '受け付けられません' } },
      { status: 401 },
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    // **200 を返す。** 読めない電文に 4xx を返すと再送され続ける
    return Response.json({ accepted: 0, skipped: 0 });
  }

  const { replies, skipped } = parseLineWebhook(parsed);

  let accepted = 0;

  for (const reply of replies) {
    try {
      if (await enqueueReply(reply)) {
        accepted += 1;
      }
    } catch {
      // **1件で全部を落とさない。** 積めなかった分は数に出ない
      logger.error('LINE返信のジョブを積めなかった', {
        eventId: reply.webhookEventId,
      });
    }
  }

  // **数だけ返す。** 返信の中身も宛先も応答に載せない（SPEC 14.2）
  return Response.json({ accepted, skipped });
}
