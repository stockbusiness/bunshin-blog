/**
 * アフィリエイトリダイレクタ（TASKS D-8、OPEN_QUESTIONS Q-001）。
 *
 * `REDIRECT` の案件で記事本文に埋まる `/go/<code>` を受け、クリックを
 * 記録してからASPへ送る。
 *
 * ## 認証が無い入口
 *
 * 叩くのは記事の読者で、ログインしていない。**セッションを見ない。**
 * その代わり、次の3つで守る。
 *
 * - **コードは推測できない値**（22文字の base64url ≒128ビット・D-8）
 * - **飛び先はDBに保存済みの値だけ。** クエリから受け取らない
 *   （受け取ると誰でも任意のURLへ飛ばせる踏み台になる）
 * - **見つからない理由を分けない。** 「コードが無い」と「案件が終了した」を
 *   区別すると、総当たりで有効なリンクの有無を調べられる
 *
 * ## 記録に失敗しても飛ばす
 *
 * **読者の遷移を止めない。** クリック数は実験の参考値で、1件の欠落より
 * 「リンクを踏んだのに何も起きない」ほうが損害が大きい。失敗はログへ残す。
 */

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { findRedirectTargetByCode } from '@/modules/affiliate';
import { recordLinkClick } from '@/modules/analytics';

export const runtime = 'nodejs';
/** コードごとに飛び先が変わる。キャッシュさせない */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await context.params;

  const target = await findRedirectTargetByCode(code);

  if (target === null) {
    return new NextResponse('リンクが見つかりません', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  try {
    await recordLinkClick({
      affiliateLinkId: target.linkId,
      referrer: request.headers.get('referer'),
      userAgent: request.headers.get('user-agent'),
    });
  } catch (error) {
    // **飛ばすほうを優先する。** 記録の失敗で遷移を止めない
    logger.error('クリックを記録できなかった', {
      linkId: target.linkId,
      cause: error,
    });
  }

  return NextResponse.redirect(target.destinationUrl, {
    // **302。** 301 だとブラウザが覚えてしまい、以後クリックを数えられない
    status: 302,
    headers: {
      'cache-control': 'no-store',
    },
  });
}
