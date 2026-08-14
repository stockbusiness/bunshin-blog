/**
 * `/api/blogs/:blogId/wordpress/*` をブラウザから呼ぶ（段6・C-1/C-2/I-8）。
 *
 * **`AppWordpressConnection` をそのまま使わない。** JSON を通ると
 * `Date` は文字列になる（`blogs-api.ts` と同じ理由）。
 *
 * **アプリケーションパスワードをここに保持しない。** 送るだけで、
 * 状態にも戻り値にも残さない（SPEC 14.2）。
 */

export type WordpressConnectionStatus =
  'UNTESTED' | 'CONNECTED' | 'FAILED' | 'REVOKED';

export interface WordpressConnectionJson {
  id: string;
  blogId: string;
  siteUrl: string;
  apiBaseUrl: string;
  connectionStatus: WordpressConnectionStatus;
  /** 認証情報が保存されているか。値そのものは返らない */
  hasCredentials: boolean;
  canCreatePosts: boolean;
  canEditPosts: boolean;
  canUploadMedia: boolean;
  /** ISO 8601。一度も試していなければ `null` */
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export type ConnectionCheckId =
  | 'URL_FORMAT'
  | 'REST_REACHABLE'
  | 'AUTH'
  | 'LIST_POSTS'
  | 'CREATE_DRAFT'
  | 'EDIT_POST'
  | 'MEDIA';

export type ConnectionCheckStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

export interface ConnectionCheckJson {
  id: ConnectionCheckId;
  status: ConnectionCheckStatus;
  code: string | null;
  message: string | null;
}

export interface ConnectionTestResultJson {
  ok: boolean;
  checks: ConnectionCheckJson[];
  canCreatePosts: boolean;
  canEditPosts: boolean;
  canUploadMedia: boolean;
  failedCode: string | null;
  failedMessage: string | null;
  /** 後始末できなかったテスト投稿。残っていれば知らせる */
  leftoverPostId: number | null;
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class WordpressApiError extends Error {
  override readonly name = 'WordpressApiError';
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

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    throw new WordpressApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new WordpressApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as T;
}

function base(blogId: string): string {
  return `/api/blogs/${encodeURIComponent(blogId)}/wordpress`;
}

export function fetchWordpressConnection(
  blogId: string,
): Promise<{ connection: WordpressConnectionJson | null }> {
  return request(base(blogId));
}

/**
 * WordPress の承認画面へ送るURLをもらう（I-8）。
 *
 * **転送はサーバーがしない。** URLを受け取って画面が開く。
 */
export function requestAuthorizeUrl(
  blogId: string,
  siteUrl: string,
): Promise<{ authorizeUrl: string }> {
  return request(`${base(blogId)}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ siteUrl }),
  });
}

/**
 * 手で貼って繋ぐ（C-1）。承認画面が使えないときの道。
 *
 * **`appPassword` を呼び出し側で保持しない。** ここへ渡したら捨てる。
 */
export function connectWordpress(
  blogId: string,
  input: { siteUrl: string; wpUsername: string; appPassword: string },
): Promise<{ connection: WordpressConnectionJson }> {
  return request(`${base(blogId)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** 7項目の接続テスト（C-2）。**失敗しても 200 で返る** */
export function testWordpressConnection(
  blogId: string,
): Promise<{ result: ConnectionTestResultJson }> {
  return request(`${base(blogId)}/test`, { method: 'POST' });
}
