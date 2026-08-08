import { prisma } from '@/lib/db';
import { decryptSecret, encryptSecret, getEncryptionKey } from '@/lib/crypto';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import { createWordpressClient, type WordpressClient } from './client';
import {
  runConnectionTest,
  type ConnectionTestResult,
} from './connection-test';
import {
  publishDraft,
  type ExistingPost,
  type PublishDraftInput,
  type PublishDraftResult,
} from './draft';
import { notConnectedError } from './errors';
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
  AppWordpressPost,
  ConnectWordpressInput,
  WordpressCredentials,
  WordpressPostStatus,
} from './types';

interface WordpressPostRow {
  id: string;
  blogId: string;
  contentItemId: string;
  wpPostId: number;
  wpPostUrl: string | null;
  wpEditUrl: string | null;
  wpStatus: string;
  lastContentHash: string;
  postedAt: Date;
  publishedAt: Date | null;
  lastSyncedAt: Date | null;
}

function toAppPost(row: WordpressPostRow): AppWordpressPost {
  return {
    id: row.id,
    blogId: row.blogId,
    contentItemId: row.contentItemId,
    wpPostId: row.wpPostId,
    wpPostUrl: row.wpPostUrl,
    wpEditUrl: row.wpEditUrl,
    wpStatus: row.wpStatus as WordpressPostStatus,
    lastContentHash: row.lastContentHash,
    postedAt: row.postedAt,
    publishedAt: row.publishedAt,
    lastSyncedAt: row.lastSyncedAt,
  };
}

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

/**
 * 接続テストを実行し、結果を保存する（C-2、SPEC 7.2・13.3）。
 *
 * **テスト結果は必ず保存する。** 成功なら `CONNECTED`、失敗なら `FAILED`。
 * 管理画面（B-7 の一覧・G-7 のダッシュボード）が「いま繋がっているか」を
 * 見るための唯一の情報になる。
 *
 * @param clientFactory 差し替え用。既定は `safeFetch` を使う実クライアント
 */
export async function testWordpressConnectionForUser(
  params: { userId: string; blogId: string },
  clientFactory?: (input: {
    apiBaseUrl: string;
    credentials: WordpressCredentials;
  }) => WordpressClient,
): Promise<ConnectionTestResult> {
  const blogId = await requireOpenBlogId(params);

  const record = await db.findByBlogId(blogId);
  if (record === null || record.connectionStatus === 'REVOKED') {
    throw notConnectedError();
  }

  const credentials = await readWordpressCredentials({ blogId }, deps);

  const client = (clientFactory ?? createWordpressClient)({
    apiBaseUrl: record.apiBaseUrl,
    credentials,
  });

  const result = await runConnectionTest({
    siteUrl: record.siteUrl,
    client,
  });

  await db.update(blogId, {
    connectionStatus: result.ok ? 'CONNECTED' : 'FAILED',
    canCreatePosts: result.canCreatePosts,
    canEditPosts: result.canEditPosts,
    canUploadMedia: result.canUploadMedia,
    lastTestedAt: new Date(),
    lastErrorCode: result.failedCode,
    lastErrorMessage: result.failedMessage,
  });

  return result;
}

const POST_SELECT = {
  id: true,
  blogId: true,
  contentItemId: true,
  wpPostId: true,
  wpPostUrl: true,
  wpEditUrl: true,
  wpStatus: true,
  lastContentHash: true,
  postedAt: true,
  publishedAt: true,
  lastSyncedAt: true,
} as const;

/**
 * 下書きを投稿し、`wordpress_posts` へ記録する（C-3、SPEC 7.3）。
 *
 * **`content_item_id` で既存の投稿を引き、あれば新規作成しない**
 * （SPEC 7.3「`wp_post_id` が存在する場合は新規投稿しない」）。
 *
 * **接続テスト（C-2）を通っていない接続では投稿しない。** 権限を
 * 確かめずに投稿すると、権限不足のエラーが記事生成のたびに出る。
 *
 * 冪等性キーによる二重実行の防止は C-4、content hash が同一なら
 * 更新しない判定は C-5。ここでは**同一 `content_item_id` に対して
 * 投稿が1件だけになる**ことまでを保証する。
 */
export async function publishDraftForUser(
  params: { userId: string; blogId: string; contentItemId: string },
  input: PublishDraftInput,
  clientFactory?: (arg: {
    apiBaseUrl: string;
    credentials: WordpressCredentials;
  }) => WordpressClient,
): Promise<AppWordpressPost> {
  const blogId = await requireOpenBlogId(params);

  const connection = await db.findByBlogId(blogId);
  if (connection === null || connection.connectionStatus !== 'CONNECTED') {
    throw notConnectedError();
  }

  const existingRow = await prisma.wordpressPost.findUnique({
    where: { contentItemId: params.contentItemId },
    select: POST_SELECT,
  });

  // 他ブログの content_item に紐づく投稿を、このブログから触らせない
  if (existingRow !== null && existingRow.blogId !== blogId) {
    throw notFoundError('記事');
  }

  const existing: ExistingPost | null =
    existingRow === null
      ? null
      : {
          wpPostId: existingRow.wpPostId,
          wpStatus: existingRow.wpStatus as ExistingPost['wpStatus'],
        };

  const credentials = await readWordpressCredentials({ blogId }, deps);

  const client = (clientFactory ?? createWordpressClient)({
    apiBaseUrl: connection.apiBaseUrl,
    credentials,
  });

  const result: PublishDraftResult = await publishDraft({
    client,
    input,
    existing,
    canCreatePosts: connection.canCreatePosts,
    canEditPosts: connection.canEditPosts,
  });

  const now = new Date();
  const saved = result.created
    ? await prisma.wordpressPost.create({
        data: {
          blogId,
          contentItemId: params.contentItemId,
          wpPostId: result.wpPostId,
          wpPostUrl: result.wpPostUrl,
          wpEditUrl: result.wpEditUrl,
          wpStatus: result.wpStatus,
          lastContentHash: result.contentHash,
          postedAt: now,
        },
        select: POST_SELECT,
      })
    : await prisma.wordpressPost.update({
        where: { contentItemId: params.contentItemId },
        data: {
          wpPostUrl: result.wpPostUrl,
          wpStatus: result.wpStatus,
          lastContentHash: result.contentHash,
          postedAt: now,
        },
        select: POST_SELECT,
      });

  return toAppPost(saved);
}

/** 投稿の記録を返す。未投稿なら `null` */
export async function findWordpressPostForUser(params: {
  userId: string;
  blogId: string;
  contentItemId: string;
}): Promise<AppWordpressPost | null> {
  const blogId = await requireOpenBlogId(params);

  const row = await prisma.wordpressPost.findUnique({
    where: { contentItemId: params.contentItemId },
    select: POST_SELECT,
  });

  if (row === null || row.blogId !== blogId) {
    return null;
  }

  return toAppPost(row);
}
