import { prisma } from '@/lib/db';
import { decryptSecret, encryptSecret, getEncryptionKey } from '@/lib/crypto';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import {
  connectWordpress,
  disconnectWordpress,
  readWordpressCredentials,
  toAppConnection,
  type StoredWordpressConnection,
  type WordpressConnectionDb,
  type WordpressConnectionWrite,
  type WordpressDeps,
  type WordpressSecretCipher,
} from './service';
import type {
  AppWordpressConnection,
  ConnectWordpressInput,
  WordpressCredentials,
} from './types';

/**
 * `wordpress_connections` テーブルへのアクセス（TASKS C-1）。
 *
 * **このモジュールだけが `wordpress_connections` を触る**（MODULE_RULES 1）。
 * **所有権は `blogs` モジュールの公開関数で確かめる**（SPEC 14.1）。
 * `wordpress_connections` を `blog.userId` で join して引くこともできるが、
 * それは `blogs` テーブルを別モジュールから条件に使うことになる。
 */

const SELECT = {
  id: true,
  blogId: true,
  siteUrl: true,
  apiBaseUrl: true,
  wpUsernameEncrypted: true,
  appPasswordEncrypted: true,
  connectionStatus: true,
  canCreatePosts: true,
  canEditPosts: true,
  canUploadMedia: true,
  lastTestedAt: true,
  lastSyncedAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

const db: WordpressConnectionDb = {
  async findByBlogId(blogId) {
    return prisma.wordpressConnection.findUnique({
      where: { blogId },
      select: SELECT,
    });
  },

  async create(blogId, data) {
    return prisma.wordpressConnection.create({
      data: { blogId, ...data },
      select: SELECT,
    });
  },

  async update(blogId, data: Partial<WordpressConnectionWrite>) {
    return prisma.wordpressConnection.update({
      where: { blogId },
      data,
      select: SELECT,
    });
  },
};

/**
 * 環境変数の鍵を使う暗号化。
 *
 * 鍵の読み出しは呼び出しのたびに行う（`getEncryptionKey` がキャッシュする）。
 * モジュール読み込み時に読むと、環境変数の要らないビルドまで落ちる。
 */
const cipher: WordpressSecretCipher = {
  encrypt(plaintext, aad) {
    return encryptSecret(plaintext, { key: getEncryptionKey(), aad });
  },

  decrypt(payload, aad) {
    return decryptSecret(payload, { key: getEncryptionKey(), aad });
  },
};

const deps: WordpressDeps = { db, cipher };

/**
 * 所有権を確かめ、対象のブログIDを返す。
 *
 * `CLOSED` のブログには接続させない。作り直しの対象であり、接続しても
 * 記事は出ない（OPEN_QUESTIONS Q-008）。**404 を返す**（B-3 の方針）。
 */
async function requireOpenBlogId(params: {
  userId: string;
  blogId: string;
}): Promise<string> {
  const blog = await requireBlogForUser(params);

  if (blog.status === 'CLOSED') {
    throw notFoundError();
  }

  return blog.id;
}

/** 接続情報を保存する。他人のブログは 404（SPEC 14.1） */
export async function connectWordpressForUser(
  params: { userId: string; blogId: string },
  input: ConnectWordpressInput,
): Promise<AppWordpressConnection> {
  const blogId = await requireOpenBlogId(params);

  return connectWordpress({ blogId, input }, deps);
}

/** 接続を切る。行は残し、`site_url` を保持する（Q-007） */
export async function disconnectWordpressForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppWordpressConnection> {
  const blogId = await requireOpenBlogId(params);

  return disconnectWordpress({ blogId }, deps);
}

/** 接続の状態を返す。未接続なら `null`。認証情報は含まない */
export async function findWordpressConnectionForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppWordpressConnection | null> {
  const blogId = await requireOpenBlogId(params);
  const record: StoredWordpressConnection | null =
    await db.findByBlogId(blogId);

  return record === null ? null : toAppConnection(record);
}

/**
 * 復号した認証情報を返す（C-2 以降が使う）。
 *
 * **戻り値をログ・レスポンスへ渡さない。** `Secret` に包まれているため
 * 素通りはしないが、`expose()` した結果を持ち回らないこと。
 */
export async function readWordpressCredentialsForUser(params: {
  userId: string;
  blogId: string;
}): Promise<WordpressCredentials> {
  const blogId = await requireOpenBlogId(params);

  return readWordpressCredentials({ blogId }, deps);
}
