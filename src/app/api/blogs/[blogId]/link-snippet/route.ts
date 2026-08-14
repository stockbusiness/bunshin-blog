import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  assertSnippetEndpoint,
  buildLinkSnippet,
  issueLinkEventTokenForUser,
} from '@/modules/blogs';

/**
 * `POST /api/blogs/:blogId/link-snippet`（TASKS I-9、D-12）
 *
 * **そのブログ専用の `bunshin-go.php` を、値を埋めた形で渡す。**
 *
 * ## なぜ渡す形にするのか
 *
 * これまでは手引きのPHPを写して**トークンと受信APIのURLを手で貼って
 * いた**（`MANUAL.md` 段10）。**貼る作業がある限り、貼り間違いが起きる。**
 * トークンは一度しか表示できず（DBにはハッシュしか無い）、
 * **間違えたことに気づくのはリンクが404になったとき**である。
 *
 * ## `POST` にする
 *
 * **取得ではなく発行である。** 呼ぶたびに新しいトークンを発行し、
 * **古いものはその瞬間に効かなくなる**（`issueLinkEventTokenForUser`）。
 *
 * `GET` を作らない理由も `link-token` と同じ — 取得の入口があると、
 * セッションを奪われたときに**置いてあるファイルの中身ごと持ち出せる。**
 *
 * ## 応答をログに残さない
 *
 * 本文にトークンの原文が入る（SPEC 14.2）。
 *
 * 他人のブログは **404**。
 */

export const runtime = 'nodejs';

type Context = { params: Promise<{ blogId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const appBaseUrl = process.env['APP_BASE_URL'];

    if (appBaseUrl === undefined || appBaseUrl.trim() === '') {
      // **リクエストの Host から作らない。** 偽の Host を送られると、
      // **クリックの送り先を攻撃者のドメインへ差し替えられる**（B-11 と同じ）
      throw new AppError(
        'CONFIGURATION_ERROR',
        503,
        'APP_BASE_URL が設定されていません',
      );
    }

    const endpoint = new URL('/api/link-events', appBaseUrl).toString();

    // **発行する前に確かめる。** 発行してから組み立てに失敗すると、
    // **古いトークンが無効になったのに新しいファイルが手に入らない**
    assertSnippetEndpoint(endpoint);

    const issued = await issueLinkEventTokenForUser({
      userId: user.id,
      blogId,
    });

    const snippet = buildLinkSnippet({ token: issued.token, endpoint });

    // **ファイルとして受け取れる形で返す。** 画面から保存して、
    // そのまま `wp-content/mu-plugins/` へ置ける
    return new Response(snippet, {
      status: 200,
      headers: {
        'content-type': 'application/x-php; charset=utf-8',
        'content-disposition': 'attachment; filename="bunshin-go.php"',
        // **保存させない。** トークンの原文が入っている
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
