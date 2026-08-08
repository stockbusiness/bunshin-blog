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
