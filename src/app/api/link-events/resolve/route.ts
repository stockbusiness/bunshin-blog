import { findLinkByCodeInBlog } from '@/modules/affiliate';
import { findBannerByCodeInBlog } from '@/modules/banners';
import { findBlogIdByLinkEventToken } from '@/modules/blogs';

/**
 * `GET /api/link-events/resolve?code=...` 飛び先を返す（TASKS D-12）。
 *
 * 各ブログのスニペットが `/go/{code}` を受けたときに引く。
 * **飛び先を持っているのは Bunshin だけ**（`affiliate_links` と `banners`）。
 *
 * ## スニペット側がキャッシュする前提で作る
 *
 * 毎クリックここへ来ると、**Bunshin が落ちた瞬間に全ブログの広告リンクが
 * 死ぬ。** スニペットは結果を保持し、次からは自前で飛ばす
 * （`docs/WORDPRESS_SNIPPET.md`）。
 *
 * ## 認証は受信APIと同じトークン
 *
 * **飛び先は誰でも見てよい値ではない。** 認証を外すと、コードを総当たりして
 * 他ブログの案件構成を外から調べられる。
 *
 * **他ブログのコードは引けない。** 解決は必ず `blogId` を条件に入れる。
 *
 * ## 見つからない理由を分けない
 *
 * 「コードが無い」と「別のブログのもの」を区別すると、総当たりで
 * 有効なコードの有無を調べられる（D-8 と同じ）。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readBearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  const matched = /^Bearer\s+(\S+)$/i.exec(header.trim());

  return matched?.[1] ?? null;
}

export async function GET(request: Request): Promise<Response> {
  const token = readBearerToken(request.headers.get('authorization'));

  if (token === null) {
    return Response.json(
      { error: { message: '認証できません' } },
      { status: 401 },
    );
  }

  const blogId = await findBlogIdByLinkEventToken(token);

  if (blogId === null) {
    return Response.json(
      { error: { message: '認証できません' } },
      { status: 401 },
    );
  }

  const code = new URL(request.url).searchParams.get('code') ?? '';

  const link = await findLinkByCodeInBlog({ blogId, code });
  const banner =
    link === null ? await findBannerByCodeInBlog({ blogId, code }) : null;
  const destinationUrl = link?.destinationUrl ?? banner?.destinationUrl ?? null;

  if (destinationUrl === null) {
    return Response.json(
      { error: { message: 'リンクが見つかりません' } },
      { status: 404 },
    );
  }

  return Response.json(
    { destinationUrl },
    // **中間に残さない。** 飛び先は認証つきで返している値
    { headers: { 'cache-control': 'no-store' } },
  );
}
