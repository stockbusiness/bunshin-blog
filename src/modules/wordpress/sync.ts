/**
 * WordPress 側の状態を取り込む（TASKS C-5、DATA_MODEL 11章）。
 *
 * ## 何を見に行くか
 *
 * - **公開状態**（`status`）。Phase 0 の公開はモニターが WordPress 上で
 *   行う（SPEC 7.4）。こちらから公開しないので、**取り込まないと
 *   公開されたことに気づけない**
 * - **本文**。利用者が WordPress 側で直接編集したかを判定する
 *
 * ## 編集の判定を時刻でやらない（DATA_MODEL 11章）
 *
 * **AIのリライトは常に後から実行される。** 単純な時刻比較では AI 側の
 * タイムスタンプが必ず新しくなり、**利用者の修正が必ず失われる**。
 *
 * 判定は「前回こちらが書き込んだ本文のハッシュ（`last_content_hash`）と
 * 一致するか」で行う。一致しなければ利用者が編集したものとして扱い、
 * **WordPress 側を正とする**。
 *
 * DBを触らない。保存は `repository.ts` の担当。
 */

import { isHttpFetchError } from '@/lib/http';
import { readWordpressError, type WordpressClient } from './client';
import { contentHash, toPostStatus } from './draft';
import { WORDPRESS_SYNC_ERROR_CODES, syncFailedError } from './errors';
import type { WordpressPostStatus } from './types';

/** WordPress から読み取った投稿の状態 */
export interface RemotePostState {
  wpStatus: WordpressPostStatus;
  /** WordPress が保存している本文のハッシュ */
  contentHash: string;
  /** 公開日時。`status` が公開でなければ `null` */
  publishedAt: Date | null;
  /** 現在の閲覧URL */
  wpPostUrl: string | null;
}

/** 同期の結果 */
export interface SyncPostResult extends RemotePostState {
  /**
   * WordPress 側で利用者が編集したか。
   *
   * `true` なら **WordPress 側が正**で、こちらから承認なしに上書きしない。
   */
  userEdited: boolean;
}

function readString(json: unknown, key: string): string | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const value = (json as Record<string, unknown>)[key];

  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `content.raw` を取り出す。
 *
 * **`rendered` で代用しない。** `rendered` はショートコードの展開や
 * 整形フィルタを通った後の文字列で、投稿のたびに変わりうる。
 * 比較に使うと、誰も編集していないのに「編集された」と判定する。
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

/**
 * 公開日時を読む。
 *
 * **`date_gmt` を使う。** `date` はサイトのタイムゾーンでの表記で、
 * オフセットが付かない。`date_gmt` も付かないため UTC として解釈する
 * （WordPress REST API の仕様）。
 *
 * **公開状態でなければ `null`。** 下書きにも `date_gmt` は入っており、
 * そのまま入れると「まだ公開していない記事に公開日時がある」ことになる。
 */
function readPublishedAt(
  json: unknown,
  status: WordpressPostStatus,
): Date | null {
  if (status !== 'PUBLISH') {
    return null;
  }

  const raw = readString(json, 'date_gmt');
  if (raw === null) {
    return null;
  }

  const parsed = new Date(`${raw}Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * WordPress から投稿の現在の状態を読む。
 *
 * **`context=edit` で取る。** `content.raw` はこの文脈でしか返らない。
 *
 * @throws {AppError} 到達不可・権限不足・投稿が消えている
 */
export async function fetchRemotePost(params: {
  client: WordpressClient;
  wpPostId: number;
}): Promise<RemotePostState> {
  let response;
  try {
    response = await params.client.request({
      path: `/wp/v2/posts/${params.wpPostId}?context=edit`,
      method: 'GET',
    });
  } catch (error) {
    if (isHttpFetchError(error)) {
      // 到達できない理由を細かく返さない（C-2・C-3 と同じ方針、SPEC 14.3）
      throw syncFailedError(
        WORDPRESS_SYNC_ERROR_CODES.unreachable,
        'WordPress へ接続できませんでした',
        error,
      );
    }

    throw syncFailedError(
      WORDPRESS_SYNC_ERROR_CODES.syncFailed,
      '状態を取得できませんでした',
      error,
    );
  }

  if (response.status === 404) {
    // モニターが記事を消した場合。**こちらで作り直さない**
    throw syncFailedError(
      WORDPRESS_SYNC_ERROR_CODES.postGone,
      'WordPress 側に記事が見つかりません。削除された可能性があります',
    );
  }

  if (response.status >= 400) {
    const error = readWordpressError(response.json);

    throw syncFailedError(
      WORDPRESS_SYNC_ERROR_CODES.syncFailed,
      error === null
        ? '状態を取得できませんでした'
        : `状態を取得できませんでした（${error.message}）`,
    );
  }

  const wpStatus = toPostStatus(
    (response.json as Record<string, unknown> | null)?.['status'],
  );

  if (wpStatus === null) {
    // `future`（予約投稿）・`private` など。**推測で埋めない**
    throw syncFailedError(
      WORDPRESS_SYNC_ERROR_CODES.unknownStatus,
      'WordPress 側の記事の状態を判別できませんでした',
    );
  }

  const raw = readRawContent(response.json);
  if (raw === null) {
    // `context=edit` が通らなかった（権限不足）。
    // **本文なしで「未編集」と判定してはならない**
    throw syncFailedError(
      WORDPRESS_SYNC_ERROR_CODES.contentUnavailable,
      '記事の本文を取得できませんでした。編集権限を確認してください',
    );
  }

  return {
    wpStatus,
    contentHash: contentHash(raw),
    publishedAt: readPublishedAt(response.json, wpStatus),
    wpPostUrl: readString(response.json, 'link'),
  };
}

/**
 * 利用者が WordPress 側で編集したか（DATA_MODEL 11章の判定手順）。
 *
 * `lastContentHash` は**前回こちらが書き込んだ本文**のハッシュ。
 * 一致すれば未編集で、AIによる更新を許可してよい。
 */
export function isUserEdited(params: {
  lastContentHash: string;
  remoteContentHash: string;
}): boolean {
  return params.lastContentHash !== params.remoteContentHash;
}

/**
 * 投稿の状態を取り込む。
 *
 * @throws {AppError} 到達不可・記事が消えている・状態を判別できない
 */
export async function syncPost(params: {
  client: WordpressClient;
  wpPostId: number;
  lastContentHash: string;
}): Promise<SyncPostResult> {
  const remote = await fetchRemotePost(params);

  return {
    ...remote,
    userEdited: isUserEdited({
      lastContentHash: params.lastContentHash,
      remoteContentHash: remote.contentHash,
    }),
  };
}
