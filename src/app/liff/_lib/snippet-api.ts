/**
 * `/api/blogs/:blogId/link-snippet` をブラウザから呼ぶ（段10・I-9/D-12）。
 *
 * **応答はJSONではない。** そのブログ専用の `bunshin-go.php` が
 * そのまま本文で返る（`content-type: application/x-php`）。
 *
 * **本文にトークンの原文が入る**（SPEC 14.2）。**保存も記録もしない。**
 * 画面が表示するあいだだけ持ち、離れれば消える。
 */

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class SnippetApiError extends Error {
  override readonly name = 'SnippetApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NETWORK_MESSAGE = '通信に失敗しました。電波の良い場所でお試しください';
const UNEXPECTED_MESSAGE = '処理できませんでした。時間をおいてお試しください';

interface ErrorBody {
  error?: { message?: string };
}

/**
 * スニペットを**発行する**。
 *
 * **取得ではない。** 呼ぶたびに新しいトークンが発行され、
 * **古いファイルはその瞬間に効かなくなる**（`link-snippet` の POST）。
 */
export async function issueLinkSnippet(blogId: string): Promise<string> {
  let response: Response;

  try {
    response = await fetch(
      `/api/blogs/${encodeURIComponent(blogId)}/link-snippet`,
      { method: 'POST' },
    );
  } catch {
    throw new SnippetApiError(0, NETWORK_MESSAGE);
  }

  if (!response.ok) {
    // 失敗のときだけJSONが返る
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    const message = (body as ErrorBody | undefined)?.error?.message;

    throw new SnippetApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return response.text();
}
