/**
 * `/api/blogs` をブラウザから呼ぶ（B-5）。
 *
 * **`AppBlog` をそのまま使わない。** JSON を通ると `Date` は文字列になる。
 * サーバー側の型を借りると、画面で `launchDate.getTime()` のような
 * 実行時に落ちるコードが型検査を通ってしまう。
 *
 * セッションは Cookie（B-2）。同一オリジンへの `fetch` は既定で送るため、
 * ここでトークンを持ち回らない。
 */

export type BlogPurpose = 'AFFILIATE' | 'DISPLAY_AD' | 'MIXED';
export type BlogStatus = 'SETUP' | 'ACTIVE' | 'PAUSED' | 'CLOSED';

export interface BlogGenreJson {
  id: string;
  name: string;
  category: string;
}

export interface BlogJson {
  id: string;
  name: string;
  slug: string;
  targetReader: string;
  penName: string | null;
  purpose: BlogPurpose;
  status: BlogStatus;
  slotNumber: number;
  articleRatio: {
    revenue: number;
    traffic: number;
    weeklyPublishCap: number;
  };
  genre: BlogGenreJson | null;
}

/** いま切れているリンク1件（H-3b、SPEC 6.1「エラー」） */
export interface BrokenLinkJson {
  offerId: string;
  offerName: string;
  /** ISO 8601。**いつから切れているか**（直す優先度がここで決まる） */
  brokenAt: string;
}

export interface BlogDetailJson {
  blog: BlogJson;
  brokenLinks: BrokenLinkJson[];
}

export interface BlogListJson {
  blogs: BlogJson[];
  slots: { limit: number; available: number[]; remaining: number };
}

/** 設定画面から送れる項目。ジャンルと算出値は含めない（Q-009・Q-011） */
export interface BlogSettingsInput {
  name: string;
  penName: string | null;
  targetReader: string;
  purpose: BlogPurpose;
  status: Exclude<BlogStatus, 'CLOSED'>;
  weeklyPublishCap: number;
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class BlogApiError extends Error {
  override readonly name = 'BlogApiError';
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
    throw new BlogApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new BlogApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as T;
}

export function fetchBlogs(): Promise<BlogListJson> {
  return request<BlogListJson>('/api/blogs');
}

export function fetchBlog(blogId: string): Promise<BlogDetailJson> {
  return request<BlogDetailJson>(`/api/blogs/${encodeURIComponent(blogId)}`);
}

export function saveBlogSettings(
  blogId: string,
  input: BlogSettingsInput,
): Promise<{ blog: BlogJson }> {
  return request<{ blog: BlogJson }>(
    `/api/blogs/${encodeURIComponent(blogId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}
