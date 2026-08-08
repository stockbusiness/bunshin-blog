/**
 * WordPress への下書き投稿（TASKS C-3、SPEC 7.3）。
 *
 * **`status: draft` 以外で投稿しない**（完了条件）。Phase 0 の公開は
 * モニターが WordPress 上で行う（SPEC 7.4）。こちらから公開しない。
 *
 * SPEC 7.3 の必須制御のうち、ここで扱うのは次の4つ。
 *
 * - `blog_id` を経由して接続情報を取得する（リクエストに接続情報を渡させない）
 * - **`wp_post_id` が存在する場合は新規投稿しない。** 再実行は既存の下書きを更新する
 * - **content hash が同一なら更新しない**（C-5）
 * - **利用者が編集した記事を承認なしに上書きしない**（C-5、DATA_MODEL 11章）
 *
 * 冪等性キー（`content_item_id` ごと）は C-4。WordPress 側の状態の
 * 取り込みは `sync.ts`。
 *
 * DBを触らない。保存は `repository.ts` の担当。
 */

import { createHash } from 'node:crypto';
import { isHttpFetchError } from '@/lib/http';
import { readWordpressError, type WordpressClient } from './client';
import {
  WORDPRESS_POST_ERROR_CODES,
  postFailedError,
  publishedPostNotEditableError,
  userEditedNotOverwritableError,
  notConnectedError,
} from './errors';
import type { WordpressPostStatus } from './types';

/** 記事本文の長さの上限。異常な入力で巨大なリクエストを投げない */
export const POST_TITLE_MAX_LENGTH = 300;
export const POST_CONTENT_MAX_BYTES = 512 * 1024;

export interface PublishDraftInput {
  title: string;
  content: string;
}

export interface PublishDraftResult {
  wpPostId: number;
  wpPostUrl: string | null;
  wpEditUrl: string | null;
  wpStatus: WordpressPostStatus;
  /** WordPress が実際に保存した本文のハッシュ。C-5 の比較に使う */
  contentHash: string;
  /** 新規作成なら `true`、既存の更新なら `false` */
  created: boolean;
  /**
   * 内容が同じだったため WordPress を呼ばずに済ませたか（C-5）。
   *
   * `true` のとき `wpPostUrl` などは既存の値のままで、
   * WordPress からの応答ではない。
   */
  skipped: boolean;
}

/** すでに投稿済みの記事の情報。無ければ `null` */
export interface ExistingPost {
  wpPostId: number;
  wpStatus: WordpressPostStatus;
  /** 前回こちらが書き込んだ本文のハッシュ（C-5） */
  lastContentHash: string;
  /** 利用者の編集を検出した時刻。`null` なら未検出（C-5、DATA_MODEL 11章） */
  userEditedAt: Date | null;
}

/**
 * 本文のハッシュを計算する。
 *
 * **WordPress が保存した本文に対して計算する。** 送った文字列ではない。
 * WordPress は保存時にサニタイズ（`wp_kses`）を行うことがあり、送った値と
 * 保存された値が一致しない。送った側で計算すると、C-5 の同期で
 * 「利用者が編集した」と誤判定する。
 */
export function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertInput(input: PublishDraftInput): void {
  if (input.title.trim() === '') {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.invalidContent,
      'タイトルが空です',
    );
  }

  if (input.title.length > POST_TITLE_MAX_LENGTH) {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.invalidContent,
      `タイトルは${POST_TITLE_MAX_LENGTH}文字以内で指定してください`,
    );
  }

  if (input.content.trim() === '') {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.invalidContent,
      '本文が空です',
    );
  }

  if (Buffer.byteLength(input.content, 'utf8') > POST_CONTENT_MAX_BYTES) {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.invalidContent,
      '本文が大きすぎます',
    );
  }
}

function readPostId(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const id = (json as Record<string, unknown>)['id'];

  return typeof id === 'number' ? id : null;
}

function readString(json: unknown, key: string): string | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const value = (json as Record<string, unknown>)[key];

  return typeof value === 'string' && value !== '' ? value : null;
}

/** WordPress の `status` を enum へ写す。知らない値は `null` */
export function toPostStatus(value: unknown): WordpressPostStatus | null {
  switch (value) {
    case 'draft':
      return 'DRAFT';
    case 'pending':
      return 'PENDING';
    case 'publish':
      return 'PUBLISH';
    case 'trash':
      return 'TRASH';
    default:
      return null;
  }
}

/**
 * 応答から `content.raw` を取り出す。
 *
 * `edit` コンテキストの応答には `content: { raw, rendered }` が入る。
 * 取れなければ `null` を返し、呼び出し側が送った本文で代用する。
 */
function readRawContent(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const content = (json as Record<string, unknown>)['content'];
  if (typeof content !== 'object' || content === null) {
    return null;
  }

  const raw = (content as Record<string, unknown>)['raw'];

  return typeof raw === 'string' ? raw : null;
}

function describeFailure(
  response: { json: unknown },
  fallback: string,
): string {
  const error = readWordpressError(response.json);

  return error === null ? fallback : `${fallback}（${error.message}）`;
}

function toPostError(error: unknown, fallback: string): never {
  if (isHttpFetchError(error)) {
    // 到達できない理由を細かく返さない（C-2 と同じ方針、SPEC 14.3）
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.unreachable,
      'WordPress へ接続できませんでした',
      error,
    );
  }

  throw postFailedError(WORDPRESS_POST_ERROR_CODES.postFailed, fallback, error);
}

/**
 * 下書きを投稿する。
 *
 * - **既に投稿済みなら新規作成しない。** 既存の投稿を更新する（SPEC 7.3）
 * - **content hash が同一なら更新しない**（C-5、SPEC 7.3）。WordPress を
 *   呼ばずに終える
 * - **更新では `status` を送らない。** Phase 0 の公開はモニターが
 *   WordPress 上で行う（SPEC 7.4）。`draft` を送ると公開済みの記事を
 *   下書きへ戻してしまう
 * - **下書き以外の投稿は更新しない。** 公開済み記事の更新は承認を必須と
 *   定めている（DATA_MODEL 11章）。承認を経る経路は F-6 で作る
 * - **利用者が編集した記事は承認なしに上書きしない**（C-5、DATA_MODEL 11章）
 *
 * @throws {AppError} 入力不正・権限不足・到達不可・公開済みの更新・利用者の編集
 */
export async function publishDraft(params: {
  client: WordpressClient;
  input: PublishDraftInput;
  existing: ExistingPost | null;
  /** 接続テスト（C-2）で作成権限が確認できているか */
  canCreatePosts: boolean;
  canEditPosts: boolean;
  /**
   * 利用者の編集を上書きしてよいか（F-6 の承認を経た場合のみ `true`）。
   *
   * **既定は `false`。** 承認の経路がまだ無い以上、上書きしないのが
   * 唯一の安全な既定である。
   */
  approvedOverwrite?: boolean;
}): Promise<PublishDraftResult> {
  const { client, input, existing } = params;

  assertInput(input);

  if (existing === null) {
    if (!params.canCreatePosts) {
      throw notConnectedError();
    }

    return createDraft(client, input);
  }

  if (existing.wpStatus !== 'DRAFT') {
    throw publishedPostNotEditableError(existing.wpStatus);
  }

  // **利用者の編集より先に判定しない。** 内容が同じなら何も起きないため、
  // 上書きの心配が無い。ここで弾くと、同じ内容の再実行が失敗になる
  if (contentHash(input.content) === existing.lastContentHash) {
    return {
      wpPostId: existing.wpPostId,
      wpPostUrl: null,
      wpEditUrl: null,
      wpStatus: existing.wpStatus,
      contentHash: existing.lastContentHash,
      created: false,
      skipped: true,
    };
  }

  // **WordPress 側を正とする**（DATA_MODEL 11章）
  if (existing.userEditedAt !== null && params.approvedOverwrite !== true) {
    throw userEditedNotOverwritableError();
  }

  if (!params.canEditPosts) {
    throw notConnectedError();
  }

  return updateDraft(client, input, existing.wpPostId);
}

async function createDraft(
  client: WordpressClient,
  input: PublishDraftInput,
): Promise<PublishDraftResult> {
  let response;
  try {
    response = await client.request({
      path: '/wp/v2/posts',
      method: 'POST',
      body: {
        title: input.title,
        content: input.content,
        // **ここを変えない。** 公開はモニターが WordPress 上で行う
        status: 'draft',
      },
    });
  } catch (error) {
    return toPostError(error, '投稿に失敗しました');
  }

  if (response.status >= 400) {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.postFailed,
      describeFailure(response, '投稿に失敗しました'),
    );
  }

  const wpPostId = readPostId(response.json);
  if (wpPostId === null) {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.postFailed,
      '投稿は作成されましたが、投稿IDを取得できませんでした',
    );
  }

  // **`draft` そのもの以外は全て異常として扱う。**
  // `toPostStatus` は知らない値を `null` にするため、それで判定すると
  // `future`（予約投稿）や `private` が下書きとして通ってしまう。
  // 完了条件は「`status: draft` 以外で投稿されない」であり、
  // **知らない状態を安全側に倒してはならない**
  const rawStatus = (response.json as Record<string, unknown> | null)?.[
    'status'
  ];

  if (rawStatus !== undefined && rawStatus !== 'draft') {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.notDraft,
      `下書きとして作成されませんでした（${String(rawStatus)}）。WordPress側の設定を確認してください`,
      undefined,
      { wpPostId },
    );
  }

  return {
    wpPostId,
    wpPostUrl: readString(response.json, 'link'),
    wpEditUrl: null,
    wpStatus: 'DRAFT',
    contentHash: contentHash(readRawContent(response.json) ?? input.content),
    created: true,
    skipped: false,
  };
}

async function updateDraft(
  client: WordpressClient,
  input: PublishDraftInput,
  wpPostId: number,
): Promise<PublishDraftResult> {
  let response;
  try {
    response = await client.request({
      path: `/wp/v2/posts/${wpPostId}`,
      method: 'POST',
      // **`status` を送らない。** 送ると WordPress 側の状態を上書きする
      body: { title: input.title, content: input.content },
    });
  } catch (error) {
    return toPostError(error, '投稿の更新に失敗しました');
  }

  if (response.status >= 400) {
    throw postFailedError(
      WORDPRESS_POST_ERROR_CODES.postFailed,
      describeFailure(response, '投稿の更新に失敗しました'),
    );
  }

  const status =
    toPostStatus(
      (response.json as Record<string, unknown> | null)?.['status'],
    ) ?? 'DRAFT';

  return {
    wpPostId,
    wpPostUrl: readString(response.json, 'link'),
    wpEditUrl: null,
    wpStatus: status,
    contentHash: contentHash(readRawContent(response.json) ?? input.content),
    created: false,
    skipped: false,
  };
}
