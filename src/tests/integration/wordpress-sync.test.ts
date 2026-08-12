import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  WORDPRESS_POST_ERROR_CODES,
  WORDPRESS_SYNC_ERROR_CODES,
  connectWordpressForUser,
  contentHash,
  findWordpressPostForUser,
  publishDraftForUser,
  syncWordpressPostForUser,
  testWordpressConnectionForUser,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * WordPress 側の状態の取り込みが**実PostgreSQLへ記録される**（C-5）。
 *
 * ここで見るのは3つ。
 *
 * - **公開状態が取り込まれること。** Phase 0 の公開はモニターが
 *   WordPress 上で行うため、取り込まないと気づけない
 * - **利用者の編集が `user_edited_at` に残ること**（DATA_MODEL 11章）
 * - **編集を検出したあと、承認なしに上書きしないこと**
 *
 * `content_items` は Phase E で作られる。ここでは最小限の行を直接入れる。
 */

const SITE_URL = 'https://monitor-blog.example.com';
const INPUT = { title: 'テスト記事', content: '<p>本文</p>' };
/** WordPress が保存した本文（そのまま返す偽サーバー） */
const STORED_HASH = contentHash(INPUT.content);

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;
let contentItemId: string;

/** 投稿先として使う `content_items` を1件作る（Phase E の代役） */
async function createContentItem(blogId: string): Promise<string> {
  const plan = await prisma.contentPlan.create({
    data: {
      blogId,
      planType: 'INITIAL',
      status: 'DRAFT',
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: 1,
      contentType: 'AFFILIATE',
      title: '記事',
      searchIntent: '購入検討',
      objective: 'REVENUE',
      publishPriority: 1,
    },
    select: { id: true },
  });

  return item.id;
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** WordPress 側の現在の状態。テストごとに書き換える */
interface RemoteState {
  status: string;
  content: string;
  dateGmt: string;
  missing: boolean;
}

let remote: RemoteState;

function responder(input: WordpressRequest): Partial<WordpressApiResponse> {
  const method = (input.method ?? 'GET').toUpperCase();

  if (input.path === '/') {
    return { status: 200, json: { namespaces: ['wp/v2'] } };
  }
  if (input.path.startsWith('/wp/v2/users/me')) {
    return {
      status: 200,
      json: { id: 1, capabilities: { upload_files: true } },
    };
  }
  if (input.path === '/wp/v2/posts' && method === 'POST') {
    remote.content = (input.body as { content?: string })?.content ?? '';

    return {
      status: 201,
      json: {
        id: 4242,
        status: 'draft',
        link: `${SITE_URL}/?p=4242`,
        content: { raw: remote.content },
      },
    };
  }
  // 取り込み（GET）
  if (/^\/wp\/v2\/posts\/\d+\?context=edit$/.test(input.path)) {
    if (remote.missing) {
      return {
        status: 404,
        json: { code: 'rest_post_invalid_id', message: '見つかりません' },
      };
    }

    return {
      status: 200,
      json: {
        id: 4242,
        status: remote.status,
        link: `${SITE_URL}/?p=4242`,
        date_gmt: remote.dateGmt,
        content: { raw: remote.content },
      },
    };
  }
  // 更新（POST）
  if (/^\/wp\/v2\/posts\/\d+$/.test(input.path) && method === 'POST') {
    remote.content = (input.body as { content?: string })?.content ?? '';

    return {
      status: 200,
      json: {
        id: 4242,
        status: 'draft',
        link: `${SITE_URL}/?p=4242`,
        content: { raw: remote.content },
      },
    };
  }
  if (method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

function createFactory(calls?: WordpressRequest[]) {
  return (): WordpressClient => ({
    async request(request) {
      calls?.push(request);
      const result = responder(request);

      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        json: result.json ?? null,
        raw: JSON.stringify(result.json ?? null),
      };
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);

  remote = {
    status: 'draft',
    content: '',
    dateGmt: '2026-08-08T01:00:00',
    missing: false,
  };

  owner = await createUser(prisma, { displayName: '所有者' });
  other = await createUser(prisma, { displayName: '別ユーザー' });

  const ownerBlog = await createBlogForUser(owner.id, {
    personaId: (await createPersona(prisma, owner.id)).id,
    name: '自分のブログ',
    slug: 'mine',
    targetReader: '読者',
    slotNumber: 1,
  });
  const otherBlog = await createBlogForUser(other.id, {
    personaId: (await createPersona(prisma, other.id)).id,
    name: '他人のブログ',
    slug: 'theirs',
    targetReader: '読者',
    slotNumber: 1,
  });

  ownerBlogId = ownerBlog.id;
  otherBlogId = otherBlog.id;
  contentItemId = await createContentItem(ownerBlogId);

  await connectWordpressForUser(
    { userId: owner.id, blogId: ownerBlogId },
    {
      siteUrl: SITE_URL,
      wpUsername: 'monitor01',
      appPassword: 'abcd EFGH ijkl MNOP qrst UVWX',
    },
  );
  await testWordpressConnectionForUser(
    { userId: owner.id, blogId: ownerBlogId },
    createFactory(),
  );

  // 1件投稿しておく
  await publishDraftForUser(
    { userId: owner.id, blogId: ownerBlogId, contentItemId },
    INPUT,
    createFactory(),
  );
});

describe('公開状態の取り込み', () => {
  it('下書きのままなら変わらない', async () => {
    const post = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(post.wpStatus).toBe('DRAFT');
    expect(post.publishedAt).toBeNull();
    expect(post.lastSyncedAt).not.toBeNull();
  });

  /**
   * Phase 0 の公開はモニターが WordPress 上で行う（SPEC 7.4）。
   * **取り込まないと公開されたことに気づけない。**
   */
  it('モニターが公開したら取り込む', async () => {
    remote.status = 'publish';

    const post = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(post.wpStatus).toBe('PUBLISH');
    expect(post.publishedAt?.toISOString()).toBe('2026-08-08T01:00:00.000Z');
  });

  // 記事が消えた場合。**こちらで作り直さない**
  it('WordPress 側から記事が消えていれば失敗する', async () => {
    remote.missing = true;

    await expect(
      syncWordpressPostForUser(
        { userId: owner.id, blogId: ownerBlogId, contentItemId },
        createFactory(),
      ),
    ).rejects.toMatchObject({ code: WORDPRESS_SYNC_ERROR_CODES.postGone });
  });
});

describe('利用者の編集（DATA_MODEL 11章）', () => {
  it('未編集なら user_edited_at は入らない', async () => {
    const post = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(post.userEditedAt).toBeNull();
    expect(post.lastContentHash).toBe(STORED_HASH);
  });

  it('書き換えられていれば検出時刻を記録する', async () => {
    remote.content = '<p>モニターが直した本文</p>';

    const post = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(post.userEditedAt).not.toBeNull();
  });

  /**
   * **`last_content_hash` を書き換えない。** 書き換えると次の同期で
   * 「未編集」に戻り、利用者の編集を見失う。
   */
  it('同期しても last_content_hash は前回書いた本文のまま', async () => {
    remote.content = '<p>モニターが直した本文</p>';

    const post = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(post.lastContentHash).toBe(STORED_HASH);
  });

  /** 何度同期しても「いつから WordPress 側が正なのか」がぶれない */
  it('検出時刻は初回のまま動かさない', async () => {
    remote.content = '<p>モニターが直した本文</p>';

    const first = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );
    const second = await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );

    expect(second.userEditedAt?.toISOString()).toBe(
      first.userEditedAt?.toISOString(),
    );
    expect(second.lastSyncedAt?.getTime()).toBeGreaterThanOrEqual(
      first.lastSyncedAt?.getTime() ?? 0,
    );
  });
});

describe('編集を検出したあとの更新', () => {
  beforeEach(async () => {
    remote.content = '<p>モニターが直した本文</p>';
    await syncWordpressPostForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      createFactory(),
    );
  });

  // **承認を経ずに上書きしてはならない**（DATA_MODEL 11章）
  it('承認なしでは上書きしない', async () => {
    const calls: WordpressRequest[] = [];

    await expect(
      publishDraftForUser(
        { userId: owner.id, blogId: ownerBlogId, contentItemId },
        { title: 'AIの書き直し', content: '<p>AIが書いた本文</p>' },
        createFactory(calls),
      ),
    ).rejects.toMatchObject({
      code: WORDPRESS_POST_ERROR_CODES.userEditedNotOverwritable,
    });

    // **1回もリクエストを出さない**
    expect(calls).toHaveLength(0);
    // WordPress 側の本文はモニターのまま
    expect(remote.content).toBe('<p>モニターが直した本文</p>');
  });

  it('承認を経れば上書きし、印を消す', async () => {
    const post = await publishDraftForUser(
      {
        userId: owner.id,
        blogId: ownerBlogId,
        contentItemId,
        approvedOverwrite: true,
      },
      { title: 'AIの書き直し', content: '<p>AIが書いた本文</p>' },
      createFactory(),
    );

    expect(post.userEditedAt).toBeNull();
    expect(post.lastContentHash).toBe(contentHash('<p>AIが書いた本文</p>'));
    expect(remote.content).toBe('<p>AIが書いた本文</p>');
  });
});

describe('content hash が同一なら更新しない（SPEC 7.3）', () => {
  it('同じ内容で投稿し直しても WordPress を呼ばない', async () => {
    const calls: WordpressRequest[] = [];

    const before = await findWordpressPostForUser({
      userId: owner.id,
      blogId: ownerBlogId,
      contentItemId,
    });

    const post = await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(calls),
    );

    expect(calls).toHaveLength(0);
    // **記録も変えない。** `posted_at` が進むと投稿し直したように見える
    expect(post.postedAt.toISOString()).toBe(before?.postedAt.toISOString());
  });

  it('内容が違えば更新する', async () => {
    const calls: WordpressRequest[] = [];

    const post = await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      { ...INPUT, content: '<p>書き直した本文</p>' },
      createFactory(calls),
    );

    expect(calls).toHaveLength(1);
    expect(post.lastContentHash).toBe(contentHash('<p>書き直した本文</p>'));
  });
});

describe('所有権（SPEC 14.1）', () => {
  it('他人のブログの記事は同期できない', async () => {
    await expect(
      syncWordpressPostForUser(
        { userId: other.id, blogId: ownerBlogId, contentItemId },
        createFactory(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  // ブログを取り違えた指定で、他人の記事に触れないこと
  it('別ブログ経由では同期できない', async () => {
    await expect(
      syncWordpressPostForUser(
        { userId: other.id, blogId: otherBlogId, contentItemId },
        createFactory(),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
