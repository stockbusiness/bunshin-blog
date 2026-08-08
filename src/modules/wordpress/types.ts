import type { Secret } from '@/lib/crypto';

/**
 * wordpress モジュールが外部へ渡す接続の表現（TASKS C-1）。
 *
 * **`*_encrypted` の列も、復号した値も、この型に含めない。**
 * SPEC 5.4「APIレスポンス、ログ、エラートラッキングへ認証情報を出力しない」。
 * 認証情報が要るのは WordPress へリクエストする瞬間だけで、そこは
 * `readCredentialsForUser` が `Secret` で返す。
 */
export interface AppWordpressConnection {
  id: string;
  blogId: string;
  /** 正規化済み。接続後は変更できない（OPEN_QUESTIONS Q-007） */
  siteUrl: string;
  apiBaseUrl: string;
  connectionStatus: WordpressConnectionStatus;
  /** 認証情報が保存されているか。値そのものは返さない */
  hasCredentials: boolean;
  /** 権限の確認結果。実際に確かめるのは C-2 の接続テスト */
  canCreatePosts: boolean;
  canEditPosts: boolean;
  canUploadMedia: boolean;
  lastTestedAt: Date | null;
  lastSyncedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** WordPress 側の投稿状態（`wordpress_posts.wp_status`） */
export type WordpressPostStatus = 'DRAFT' | 'PENDING' | 'PUBLISH' | 'TRASH';

export type WordpressConnectionStatus =
  'UNTESTED' | 'CONNECTED' | 'FAILED' | 'REVOKED';

/**
 * 接続の入力（SPEC 13.3 `POST /api/blogs/:id/wordpress/connect`）。
 *
 * `siteUrl` は正規化前の生の入力。`normalizeSiteUrl` を通してから保存する。
 */
export interface ConnectWordpressInput {
  siteUrl: string;
  wpUsername: string;
  appPassword: string;
}

/**
 * 復号済みの認証情報。
 *
 * **`Secret` で包む。** 生の文字列で返すと、そのままログやレスポンスへ
 * 流れる経路ができる。使うのは C-2 以降の WordPress 呼び出しのみ。
 */
export interface WordpressCredentials {
  username: Secret;
  appPassword: Secret;
}

/**
 * `wordpress_posts` の外向け表現（C-3）。
 *
 * WordPress 側の識別子と状態だけを持つ。記事本文は持たない
 * （本文の正本は `article_versions` と WordPress 側・DATA_MODEL 11章）。
 */
export interface AppWordpressPost {
  id: string;
  blogId: string;
  contentItemId: string;
  wpPostId: number;
  wpPostUrl: string | null;
  wpEditUrl: string | null;
  wpStatus: WordpressPostStatus;
  /** WordPress が保存した本文のハッシュ。C-5 の編集検出に使う */
  lastContentHash: string;
  postedAt: Date;
  publishedAt: Date | null;
  lastSyncedAt: Date | null;
  /**
   * 利用者が WordPress 側で編集したことを検出した時刻（C-5）。
   *
   * `null` は未検出。**設定されている間は WordPress 側が正**で、
   * 承認なしに上書きしない（DATA_MODEL 11章）。
   */
  userEditedAt: Date | null;
}
