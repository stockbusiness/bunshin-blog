/**
 * WordPress接続情報の保存（TASKS C-1、SPEC 5.4・13.3）。
 *
 * DBと暗号化を差し込みで受け取る。**所有権の検証はここではやらない。**
 * 呼び出し元（`repository.ts`）が `blogs` モジュールで先に確かめ、
 * 確定した `blogId` だけを渡す（SPEC 14.1）。
 */

import { AppError } from '@/lib/errors';
import { isEmptyPayload, type Secret } from '@/lib/crypto';
import { credentialsUnreadableError, notConnectedError } from './errors';
import {
  assertSiteUrlUnchanged,
  deriveApiBaseUrl,
  normalizeSiteUrl,
} from './site-url';
import type {
  AppWordpressConnection,
  ConnectWordpressInput,
  WordpressConnectionStatus,
  WordpressCredentials,
} from './types';

/** 入力の上限。WordPress のユーザー名・アプリケーションパスワードに合わせる */
export const WP_USERNAME_MAX_LENGTH = 100;
export const APP_PASSWORD_MAX_LENGTH = 200;

/** DBに入っているままの行。暗号文を含むため、この型を外へ公開しない */
export interface StoredWordpressConnection {
  id: string;
  blogId: string;
  siteUrl: string;
  apiBaseUrl: string;
  wpUsernameEncrypted: string;
  appPasswordEncrypted: string;
  connectionStatus: string;
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

/** 書き込む値。`blogId` と `siteUrl` は作成時にのみ決まる */
export interface WordpressConnectionWrite {
  siteUrl: string;
  apiBaseUrl: string;
  wpUsernameEncrypted: string;
  appPasswordEncrypted: string;
  connectionStatus: WordpressConnectionStatus;
  canCreatePosts: boolean;
  canEditPosts: boolean;
  canUploadMedia: boolean;
  lastTestedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface WordpressConnectionDb {
  findByBlogId(blogId: string): Promise<StoredWordpressConnection | null>;
  create(
    blogId: string,
    data: WordpressConnectionWrite,
  ): Promise<StoredWordpressConnection>;
  update(
    blogId: string,
    data: Partial<WordpressConnectionWrite>,
  ): Promise<StoredWordpressConnection>;
}

/**
 * 暗号化の差し込み口。
 *
 * `aad` は暗号文を「その行のその列」に結び付ける。差し替えられても
 * 復号できないようにするため、呼び出し側では組み立てさせない。
 */
export interface WordpressSecretCipher {
  encrypt(plaintext: string, aad: string): string;
  decrypt(payload: string, aad: string): Secret;
}

export interface WordpressDeps {
  db: WordpressConnectionDb;
  cipher: WordpressSecretCipher;
}

/** 暗号文を結び付ける対象。ブログと列が変われば復号できない */
export function credentialAad(blogId: string, field: string): string {
  return `wordpress_connection:${blogId}:${field}`;
}

const USERNAME_FIELD = 'wp_username';
const APP_PASSWORD_FIELD = 'app_password';

/**
 * DBの行を外向けの表現へ変換する。
 *
 * **暗号文の列をここで落とす。** 変換をこの1関数に集約することで、
 * 「うっかりそのまま返す」経路を作らない。
 */
export function toAppConnection(
  record: StoredWordpressConnection,
): AppWordpressConnection {
  return {
    id: record.id,
    blogId: record.blogId,
    siteUrl: record.siteUrl,
    apiBaseUrl: record.apiBaseUrl,
    connectionStatus: record.connectionStatus as WordpressConnectionStatus,
    hasCredentials: !isEmptyPayload(record.appPasswordEncrypted),
    canCreatePosts: record.canCreatePosts,
    canEditPosts: record.canEditPosts,
    canUploadMedia: record.canUploadMedia,
    lastTestedAt: record.lastTestedAt,
    lastSyncedAt: record.lastSyncedAt,
    lastErrorCode: record.lastErrorCode,
    lastErrorMessage: record.lastErrorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeUsername(value: string): string {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw AppError.validationFailed('WordPressのユーザー名を入力してください');
  }

  if (trimmed.length > WP_USERNAME_MAX_LENGTH) {
    throw AppError.validationFailed(
      `WordPressのユーザー名は${WP_USERNAME_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  return trimmed;
}

/**
 * アプリケーションパスワードから空白を取り除く。
 *
 * WordPress の管理画面は `abcd EFGH ijkl ...` と4文字ずつ区切って表示し、
 * 認証時に空白を無視する。**貼り付けたまま保存すると人によって
 * 空白の有無が変わる**ため、保存前に揃える。
 */
function normalizeAppPassword(value: string): string {
  const stripped = value.replace(/\s+/g, '');

  if (stripped === '') {
    throw AppError.validationFailed(
      'アプリケーションパスワードを入力してください',
    );
  }

  if (stripped.length > APP_PASSWORD_MAX_LENGTH) {
    throw AppError.validationFailed(
      `アプリケーションパスワードは${APP_PASSWORD_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  return stripped;
}

/**
 * 接続情報を保存する（新規接続・再接続の両方）。
 *
 * - 接続先の変更は拒否する（OPEN_QUESTIONS Q-007）
 * - 同一URLのままの再接続は許可し、**認証情報を入れ替える**
 * - 再接続では権限とテスト結果を初期化する。**認証情報が変われば
 *   以前のテスト結果は当てにならない**（SPEC 7.2 の確認をやり直す）
 */
export async function connectWordpress(
  params: { blogId: string; input: ConnectWordpressInput },
  deps: WordpressDeps,
): Promise<AppWordpressConnection> {
  const { blogId, input } = params;

  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const username = normalizeUsername(input.wpUsername);
  const appPassword = normalizeAppPassword(input.appPassword);

  const existing = await deps.db.findByBlogId(blogId);

  assertSiteUrlUnchanged({
    stored: existing?.siteUrl,
    incoming: siteUrl,
  });

  const credentials = {
    wpUsernameEncrypted: deps.cipher.encrypt(
      username,
      credentialAad(blogId, USERNAME_FIELD),
    ),
    appPasswordEncrypted: deps.cipher.encrypt(
      appPassword,
      credentialAad(blogId, APP_PASSWORD_FIELD),
    ),
  };

  const write: WordpressConnectionWrite = {
    siteUrl,
    apiBaseUrl: deriveApiBaseUrl(siteUrl),
    ...credentials,
    // 保存しただけでは繋がったことにならない。C-2 の接続テストを通って
    // はじめて CONNECTED になる（SPEC 7.2）
    connectionStatus: 'UNTESTED',
    canCreatePosts: false,
    canEditPosts: false,
    canUploadMedia: false,
    lastTestedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };

  const saved =
    existing === null
      ? await deps.db.create(blogId, write)
      : await deps.db.update(blogId, write);

  return toAppConnection(saved);
}

/**
 * 接続を切る（SPEC 13.3 `DELETE .../disconnect`）。
 *
 * - **行は消さない。`site_url` を残す**（Q-007）。再接続時に一致を確認する
 * - **認証情報は空で上書きする。** 使えない資格情報を持ち続けない。
 *   列は NOT NULL のため、空文字を暗号化した値を入れる
 * - 再接続にはアプリケーションパスワードの入力し直しが要る。
 *   WordPress 側で失効させてからの切断が通常の流れであり、
 *   同じ値を残しても使えない
 */
export async function disconnectWordpress(
  params: { blogId: string },
  deps: WordpressDeps,
): Promise<AppWordpressConnection> {
  const { blogId } = params;

  const existing = await deps.db.findByBlogId(blogId);
  if (existing === null) {
    throw notConnectedError();
  }

  const saved = await deps.db.update(blogId, {
    connectionStatus: 'REVOKED',
    wpUsernameEncrypted: deps.cipher.encrypt(
      '',
      credentialAad(blogId, USERNAME_FIELD),
    ),
    appPasswordEncrypted: deps.cipher.encrypt(
      '',
      credentialAad(blogId, APP_PASSWORD_FIELD),
    ),
    canCreatePosts: false,
    canEditPosts: false,
    canUploadMedia: false,
    lastErrorCode: null,
    lastErrorMessage: null,
  });

  return toAppConnection(saved);
}

/**
 * 保存された認証情報を復号する。
 *
 * **WordPress へリクエストする直前でだけ呼ぶ**（C-2 以降）。戻り値は
 * `Secret` で包まれており、ログにもレスポンスにも素通りしない。
 *
 * @throws {AppError} 未接続・切断済み（404）、復号できない（500）
 */
export async function readWordpressCredentials(
  params: { blogId: string },
  deps: WordpressDeps,
): Promise<WordpressCredentials> {
  const { blogId } = params;

  const existing = await deps.db.findByBlogId(blogId);
  if (existing === null || existing.connectionStatus === 'REVOKED') {
    throw notConnectedError();
  }

  if (isEmptyPayload(existing.appPasswordEncrypted)) {
    throw notConnectedError();
  }

  try {
    return {
      username: deps.cipher.decrypt(
        existing.wpUsernameEncrypted,
        credentialAad(blogId, USERNAME_FIELD),
      ),
      appPassword: deps.cipher.decrypt(
        existing.appPasswordEncrypted,
        credentialAad(blogId, APP_PASSWORD_FIELD),
      ),
    };
  } catch (error) {
    throw credentialsUnreadableError(error);
  }
}
