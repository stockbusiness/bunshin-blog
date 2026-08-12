import { logger } from '@/lib/logger';
import { findLinkByCodeInBlog } from '@/modules/affiliate';
import {
  parseLinkEvents,
  recordLinkEvents,
  type ResolvedLinkEvent,
} from '@/modules/analytics';
import { findBannerByCodeInBlog } from '@/modules/banners';
import { findBlogIdByLinkEventToken } from '@/modules/blogs';

/**
 * `POST /api/link-events` クリックの受信（TASKS D-12、Q-001 の再決定）。
 *
 * リダイレクタを各ブログのドメインへ移した（**30ブログが同一の外部ドメインへ
 * リンクすると、運営者の同一性を示す痕跡になる**）ため、クリックは
 * 各WordPressのスニペットからここへ送られてくる。
 *
 * ## 認証はブログ単位のトークン
 *
 * `Authorization: Bearer <token>` で受け、**トークンからブログを引く**
 * （`blogs.link_event_token_hash` は `UNIQUE`）。ブログIDを本文で受けて
 * から照合する形にすると、**照合を1か所忘れただけで他ブログのイベントを
 * 名乗れる。**
 *
 * ## 他ブログのコードを混ぜられない
 *
 * `code` の解決は必ず `blogId` を条件に入れる。混ぜて送られても
 * **そのブログのクリック数を外から水増しできない。**
 *
 * ## 壊れた1件で全部を落とさない
 *
 * 送信元は失敗した分を保持して再送する（Q-001 再決定）。1件でも弾いて
 * 400 を返すと、**その1件のせいで同じ電文が延々と送られ続ける。**
 * 通るものだけ通し、落としたものは応答で数えて返す。
 *
 * ## 個人情報を受け取らない
 *
 * 受けるのは**参照元のホスト名**と**UAのsha256**だけ。IPアドレスは
 * 保存しない（アクセスログにも残さない — このハンドラは記録しない）。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `Authorization: Bearer <token>` からトークンを取り出す */
function readBearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  const matched = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return matched?.[1] ?? null;
}

function unauthorized(): Response {
  // **理由を分けない。** 「トークンが無い」と「効かない」を区別すると、
  // 総当たりで有効なトークンの有無を調べられる
  return Response.json(
    { error: { message: '認証できません' } },
    { status: 401 },
  );
}

export async function POST(request: Request): Promise<Response> {
  const token = readBearerToken(request.headers.get('authorization'));

  if (token === null) {
    return unauthorized();
  }

  const blogId = await findBlogIdByLinkEventToken(token);

  if (blogId === null) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // **形が壊れていても 400 は返す。** ここは再送しても直らない
    return Response.json(
      { error: { message: 'リクエストの形式が不正です' } },
      { status: 400 },
    );
  }

  const parsed = parseLinkEvents(body);
  const resolved: ResolvedLinkEvent[] = [];
  let unknown = 0;

  for (const event of parsed.events) {
    const link = await findLinkByCodeInBlog({ blogId, code: event.code });
    const banner =
      link === null
        ? await findBannerByCodeInBlog({ blogId, code: event.code })
        : null;

    // **どちらでもないコードは落とす。** 記事を消したあとに遅れて届く
    // ものがあり、異常ではない
    if (link === null && banner === null) {
      unknown += 1;
      continue;
    }

    resolved.push({
      ...event,
      affiliateLinkId: link?.id ?? null,
      bannerId: banner?.id ?? null,
    });
  }

  try {
    const result = await recordLinkEvents(resolved);

    return Response.json({
      inserted: result.inserted,
      duplicated: result.duplicated,
      unknown,
      rejected: parsed.rejected,
    });
  } catch (error) {
    // **失敗は 500 で返す。** 送信元は保持して再送する
    logger.error('クリックの受信に失敗した', { blogId, cause: error });

    return Response.json(
      { error: { message: '保存できませんでした' } },
      { status: 500 },
    );
  }
}
