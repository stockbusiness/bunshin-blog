import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { decryptSecret, encryptSecret, getEncryptionKey } from '@/lib/crypto';
import { recordAudit } from '@/modules/audit';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import { createWordpressClient, type WordpressClient } from './client';
import {
  hasWpV2Namespace,
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
  deriveApiBaseUrl,
  derivePlainApiBaseUrl,
  restStyleOf,
} from './site-url';
import { syncPost } from './sync';
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
  userEditedAt: Date | null;
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
    userEditedAt: row.userEditedAt,
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

  const connection = await connectWordpress({ blogId, input }, deps);

  // **接続の変更を残す**（SPEC 14.4「WordPress接続変更」、H-12）。
  // **接続情報は入れない** — ユーザー名もアプリケーションパスワードも
  // 秘密で、監査ログに入れてよい値ではない（SPEC 14.2）。
  // 残すのは「どのブログの接続が、いつ、どこへ向いたか」だけ
  await recordAudit({
    actorUserId: params.userId,
    action: 'WORDPRESS_CONNECTED',
    entityType: 'blog',
    entityId: blogId,
    metadata: { siteUrl: connection.siteUrl },
  });

  return connection;
}

/** 接続を切る。行は残し、`site_url` を保持する（Q-007） */
export async function disconnectWordpressForUser(params: {
  userId: string;
  blogId: string;
}): Promise<AppWordpressConnection> {
  const blogId = await requireOpenBlogId(params);

  const connection = await disconnectWordpress({ blogId }, deps);

  // **切ったことも「接続変更」**（SPEC 14.4、H-12）。投稿が止まった理由を
  // 後から辿るのに要る
  await recordAudit({
    actorUserId: params.userId,
    action: 'WORDPRESS_DISCONNECTED',
    entityType: 'blog',
    entityId: blogId,
  });

  return connection;
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
/**
 * 届く REST の入口を選ぶ（Q-052）。
 *
 * ## なぜ2つ試すのか
 *
 * **パーマリンクが「基本」のサイトでは `/wp-json/` が404になる。**
 * WordPress がその書き換え規則を作らないためで、**サイトも REST も
 * 生きている。** 実際に本番のサイトがこの状態だった（2026-08-15）。
 *
 * **`/index.php?rest_route=` は書き換えを通らない**ので届く。
 * WordPress 自身が `_links.self` でこの形を案内している。
 *
 * ## 逃げ道で通っても、そのままにしない
 *
 * 書き換えが効いていないと、**段10で入れる `/go/{code}` も404になる。**
 * だから `runConnectionTest` へ形を渡し、**通っても画面で伝える。**
 *
 * ## 保存済みの形を先に試す
 *
 * 2回目からは1回で当たる。**毎回2回叩かない。**
 */
async function resolveReachableBase(params: {
  siteUrl: string;
  storedBase: string;
  credentials: WordpressCredentials;
  factory: (input: {
    apiBaseUrl: string;
    credentials: WordpressCredentials;
  }) => WordpressClient;
}): Promise<{ apiBaseUrl: string; client: WordpressClient }> {
  const candidates = [
    params.storedBase,
    deriveApiBaseUrl(params.siteUrl),
    derivePlainApiBaseUrl(params.siteUrl),
  ].filter((base, index, all) => all.indexOf(base) === index);

  for (const apiBaseUrl of candidates) {
    const client = params.factory({
      apiBaseUrl,
      credentials: params.credentials,
    });

    try {
      const root = await client.request({ path: '/', authenticated: false });

      if (root.status < 400 && hasWpV2Namespace(root.json)) {
        return { apiBaseUrl, client };
      }
    } catch {
      // 次の候補へ。**理由はここで判断しない** —
      // どれも駄目なら `runConnectionTest` が同じ失敗をもう一度拾い、
      // **モニターへ出す文言はそこが決める**
    }
  }

  // **保存済みの形で流す。** 失敗の理由は接続テストが出す
  return {
    apiBaseUrl: params.storedBase,
    client: params.factory({
      apiBaseUrl: params.storedBase,
      credentials: params.credentials,
    }),
  };
}

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
  const factory = clientFactory ?? createWordpressClient;

  const resolved = await resolveReachableBase({
    siteUrl: record.siteUrl,
    storedBase: record.apiBaseUrl,
    credentials,
    factory,
  });

  const result = await runConnectionTest({
    siteUrl: record.siteUrl,
    client: resolved.client,
    restStyle: restStyleOf(resolved.apiBaseUrl),
  });

  await db.update(blogId, {
    // **届いた形を覚える**（Q-052）。次からは1回で当たる
    apiBaseUrl: resolved.apiBaseUrl,
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
  userEditedAt: true,
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
 * **content hash が同一なら WordPress を呼ばない**（C-5）。この場合は
 * 記録も変えない。冪等性キーによる二重実行の防止は C-4。
 */
export async function publishDraftForUser(
  params: {
    userId: string;
    blogId: string;
    contentItemId: string;
    /** 利用者の編集を上書きしてよいか（F-6 の承認を経た場合のみ、C-5） */
    approvedOverwrite?: boolean;
  },
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
          lastContentHash: existingRow.lastContentHash,
          userEditedAt: existingRow.userEditedAt,
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
    ...(params.approvedOverwrite === undefined
      ? {}
      : { approvedOverwrite: params.approvedOverwrite }),
  });

  // **内容が同じなら記録も変えない**（C-5）。`posted_at` を進めると、
  // 何もしていないのに投稿し直したように見える。
  // **監査ログも書かない** — 何も起きていないため
  if (result.skipped) {
    return toAppPost(existingRow as NonNullable<typeof existingRow>);
  }

  const now = new Date();
  const saved = result.created
    ? await createPostRow({
        blogId,
        contentItemId: params.contentItemId,
        result,
        now,
      })
    : await prisma.wordpressPost.update({
        where: { contentItemId: params.contentItemId },
        data: {
          wpPostUrl: result.wpPostUrl,
          wpStatus: result.wpStatus,
          lastContentHash: result.contentHash,
          postedAt: now,
          // **上書きし終えたら編集の印を消す**（C-5）。ここまで来るのは
          // 承認を経た場合だけで、こちらの本文が新しい正本になる
          userEditedAt: null,
        },
        select: POST_SELECT,
      });

  // **WordPress へ送ったことを残す**（SPEC 14.4「公開」、H-12）。
  //
  // **行為者は `null`。** 実際に送るのはジョブで、人が押した瞬間とは
  // 別の時刻に動く。誰が通したかは直前の `ARTICLE_APPROVED` にある。
  //
  // **Phase 0 で作るのは下書きだけ**（SPEC 7）。`wpStatus` を残すので、
  // 公開の運用が変わっても記録の読み方は変わらない
  await recordAudit({
    actorUserId: null,
    action: 'ARTICLE_POSTED',
    entityType: 'content_item',
    entityId: params.contentItemId,
    metadata: {
      blogId,
      wpPostId: saved.wpPostId,
      wpStatus: saved.wpStatus,
      created: result.created,
    },
  });

  return toAppPost(saved);
}

/**
 * 投稿の記録を作る（C-6）。
 *
 * **記事が別のブログのものなら、DBの複合外部キーが弾く。**
 * `wordpress_posts (content_item_id, blog_id)` → `content_items (id, blog_id)`
 * （C-6-schema）。ここで確かめようとすると `wordpress` が `content_items` を
 * 直接読むことになり、MODULE_RULES 1 に反する。
 *
 * **弾かれた場合は 404 に揃える。** 他の越境と同じ見え方にする。
 *
 * なお、この時点では WordPress 側に下書きが1件できている（外部呼び出しが
 * 先にあるため）。**残るのは指定した本人のサイトで、相手には影響しない。**
 * 事前に防ぐにはモジュール境界を越えるしかなく、割に合わない。
 */
async function createPostRow(params: {
  blogId: string;
  contentItemId: string;
  result: PublishDraftResult;
  now: Date;
}): Promise<WordpressPostRow> {
  try {
    return await prisma.wordpressPost.create({
      data: {
        blogId: params.blogId,
        contentItemId: params.contentItemId,
        wpPostId: params.result.wpPostId,
        wpPostUrl: params.result.wpPostUrl,
        wpEditUrl: params.result.wpEditUrl,
        wpStatus: params.result.wpStatus,
        lastContentHash: params.result.contentHash,
        postedAt: params.now,
      },
      select: POST_SELECT,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      throw notFoundError('記事');
    }

    throw error;
  }
}

/**
 * WordPress 側の状態を取り込む（C-5、DATA_MODEL 11章）。
 *
 * - **公開状態を取り込む。** Phase 0 の公開はモニターが WordPress 上で
 *   行うため、取り込まないと公開に気づけない
 * - **利用者の編集を検出する。** `last_content_hash` と一致しなければ
 *   `user_edited_at` に検出時刻を残す
 *
 * **`last_content_hash` を書き換えない。** 書き換えると、次の同期で
 * 「未編集」に戻り、利用者の編集を見失う。ハッシュが指すのは常に
 * **前回こちらが書き込んだ本文**である。
 *
 * @throws {AppError} 他人のブログ（404）・未接続・到達不可・記事が消えている
 */
export async function syncWordpressPostForUser(
  params: { userId: string; blogId: string; contentItemId: string },
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

  const row = await prisma.wordpressPost.findUnique({
    where: { contentItemId: params.contentItemId },
    select: POST_SELECT,
  });

  if (row === null || row.blogId !== blogId) {
    throw notFoundError('記事');
  }

  const credentials = await readWordpressCredentials({ blogId }, deps);

  const client = (clientFactory ?? createWordpressClient)({
    apiBaseUrl: connection.apiBaseUrl,
    credentials,
  });

  const result = await syncPost({
    client,
    wpPostId: row.wpPostId,
    lastContentHash: row.lastContentHash,
  });

  const now = new Date();
  const saved = await prisma.wordpressPost.update({
    where: { contentItemId: params.contentItemId },
    data: {
      wpStatus: result.wpStatus,
      ...(result.wpPostUrl === null ? {} : { wpPostUrl: result.wpPostUrl }),
      // 公開日時は WordPress 側が持つ。**一度入った値を消さない**
      ...(result.publishedAt === null
        ? {}
        : { publishedAt: result.publishedAt }),
      lastSyncedAt: now,
      // **初めて検出した時刻を残す。** 毎回の同期で進めると、
      // 「いつから WordPress 側が正なのか」が分からなくなる
      ...(result.userEdited && row.userEditedAt === null
        ? { userEditedAt: now }
        : {}),
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
