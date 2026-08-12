import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listAuditLogsForAdmin } from '@/modules/audit';
import { createBlogForUser } from '@/modules/blogs';
import {
  WORDPRESS_POST_ERROR_CODES,
  connectWordpressForUser,
  findWordpressPostForUser,
  publishDraftForUser,
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
 * 下書き投稿が**実PostgreSQLへ記録される**ことを確かめる（C-3）。
 *
 * 投稿の組み立てそのものは `src/tests/modules/wordpress/draft.test.ts`
 * の担当。ここで見るのは記録・再実行・所有権。
 *
 * `content_items` は Phase E で作られる。ここでは最小限の行を直接入れる。
 */

const SITE_URL = 'https://monitor-blog.example.com';
const INPUT = { title: 'テスト記事', content: '<p>本文</p>' };

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;
let contentItemId: string;
let otherContentItemId: string;

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

/** すべて成功する WordPress を模す */
function healthyResponder(
  input: WordpressRequest,
): Partial<WordpressApiResponse> {
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
    return {
      status: 201,
      json: {
        id: 4242,
        status: 'draft',
        link: 'https://monitor-blog.example.com/?p=4242',
        content: { raw: (input.body as { content?: string })?.content ?? '' },
      },
    };
  }
  if (/^\/wp\/v2\/posts\/\d+$/.test(input.path) && method === 'POST') {
    return {
      status: 200,
      json: {
        id: 4242,
        status: 'draft',
        link: 'https://monitor-blog.example.com/?p=4242',
        content: { raw: (input.body as { content?: string })?.content ?? '' },
      },
    };
  }
  if (method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

function createFactory(
  responder: (input: WordpressRequest) => Partial<WordpressApiResponse>,
  calls?: WordpressRequest[],
) {
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
  otherContentItemId = await createContentItem(otherBlogId);

  for (const [userId, blogId] of [
    [owner.id, ownerBlogId],
    [other.id, otherBlogId],
  ] as const) {
    await connectWordpressForUser(
      { userId, blogId },
      {
        siteUrl: SITE_URL,
        wpUsername: 'monitor01',
        appPassword: 'abcd EFGH ijkl MNOP qrst UVWX',
      },
    );
    // C-2 を通さないと投稿できない
    await testWordpressConnectionForUser(
      { userId, blogId },
      createFactory(healthyResponder),
    );
  }
});

describe('下書きの記録', () => {
  it('投稿すると wordpress_posts に記録される', async () => {
    const post = await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder),
    );

    expect(post).toMatchObject({
      blogId: ownerBlogId,
      contentItemId,
      wpPostId: 4242,
      wpStatus: 'DRAFT',
      wpPostUrl: 'https://monitor-blog.example.com/?p=4242',
    });
    expect(post.lastContentHash).toHaveLength(64);
    expect(await prisma.wordpressPost.count()).toBe(1);
  });

  it('取得できる', async () => {
    await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder),
    );

    const post = await findWordpressPostForUser({
      userId: owner.id,
      blogId: ownerBlogId,
      contentItemId,
    });

    expect(post?.wpPostId).toBe(4242);
  });

  it('未投稿なら null', async () => {
    expect(
      await findWordpressPostForUser({
        userId: owner.id,
        blogId: ownerBlogId,
        contentItemId,
      }),
    ).toBeNull();
  });
});

describe('再実行（SPEC 7.3「wp_post_id が存在する場合は新規投稿しない」）', () => {
  it('2回目は新規作成せず更新する', async () => {
    const calls: WordpressRequest[] = [];

    await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder, calls),
    );
    await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      { ...INPUT, title: '書き直した記事' },
      createFactory(healthyResponder, calls),
    );

    const creates = calls.filter(
      (call) =>
        call.path === '/wp/v2/posts' &&
        (call.method ?? '').toUpperCase() === 'POST',
    );

    expect(creates).toHaveLength(1);
    // 行も1件のまま
    expect(await prisma.wordpressPost.count()).toBe(1);
  });

  it('更新でハッシュが入れ替わる', async () => {
    const first = await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder),
    );

    const second = await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      { ...INPUT, content: '<p>書き直した本文</p>' },
      createFactory(healthyResponder),
    );

    expect(second.lastContentHash).not.toBe(first.lastContentHash);
  });

  // DATA_MODEL 11章
  it('公開済みになっていたら更新しない', async () => {
    await publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder),
    );

    // モニターが WordPress 上で公開した状態を作る
    await prisma.wordpressPost.update({
      where: { contentItemId },
      data: { wpStatus: 'PUBLISH' },
    });

    await expect(
      publishDraftForUser(
        { userId: owner.id, blogId: ownerBlogId, contentItemId },
        INPUT,
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({
      code: WORDPRESS_POST_ERROR_CODES.publishedNotEditable,
    });
  });
});

describe('接続の前提', () => {
  it('接続テストを通っていなければ投稿しない', async () => {
    const second = await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: '未テスト',
      slug: 'untested',
      targetReader: '読者',
      slotNumber: 2,
    });
    const item = await createContentItem(second.id);

    await connectWordpressForUser(
      { userId: owner.id, blogId: second.id },
      {
        siteUrl: 'https://another.example.com',
        wpUsername: 'monitor01',
        appPassword: 'abcdefghijklmnop',
      },
    );

    await expect(
      publishDraftForUser(
        { userId: owner.id, blogId: second.id, contentItemId: item },
        INPUT,
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'WORDPRESS_NOT_CONNECTED' });
  });

  it('接続テストが失敗していれば投稿しない', async () => {
    await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory((input) =>
        input.path === '/'
          ? { status: 500, json: {} }
          : healthyResponder(input),
      ),
    );

    await expect(
      publishDraftForUser(
        { userId: owner.id, blogId: ownerBlogId, contentItemId },
        INPUT,
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'WORDPRESS_NOT_CONNECTED' });
  });
});

describe('テナント分離（SPEC 14.1）', () => {
  it('他人のブログへは投稿できない（404）', async () => {
    await expect(
      publishDraftForUser(
        {
          userId: owner.id,
          blogId: otherBlogId,
          contentItemId: otherContentItemId,
        },
        INPUT,
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });

    expect(await prisma.wordpressPost.count()).toBe(0);
  });

  // 自分のブログIDと他人の content_item を組み合わせて投稿させない
  it('他ブログの記事IDを自分のブログから投稿できない（404）', async () => {
    await publishDraftForUser(
      {
        userId: other.id,
        blogId: otherBlogId,
        contentItemId: otherContentItemId,
      },
      INPUT,
      createFactory(healthyResponder),
    );

    await expect(
      publishDraftForUser(
        {
          userId: owner.id,
          blogId: ownerBlogId,
          contentItemId: otherContentItemId,
        },
        INPUT,
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ status: 404 });

    // 他人の投稿は変わっていない
    const theirs = await prisma.wordpressPost.findUnique({
      where: { contentItemId: otherContentItemId },
      select: { blogId: true },
    });
    expect(theirs?.blogId).toBe(otherBlogId);
  });

  it('他人の投稿を取得できない', async () => {
    await publishDraftForUser(
      {
        userId: other.id,
        blogId: otherBlogId,
        contentItemId: otherContentItemId,
      },
      INPUT,
      createFactory(healthyResponder),
    );

    await expect(
      findWordpressPostForUser({
        userId: owner.id,
        blogId: otherBlogId,
        contentItemId: otherContentItemId,
      }),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND' });
  });
});

/**
 * 監査ログ（TASKS H-12、SPEC 14.4「公開」、Q-027）。
 *
 * **Phase 0 で作るのは下書きだけ**（SPEC 7）。公開はモニターが
 * WordPress 側で行うので、こちらが記録できるのはここまで。
 */
describe('投稿の記録', () => {
  async function post() {
    return publishDraftForUser(
      { userId: owner.id, blogId: ownerBlogId, contentItemId },
      INPUT,
      createFactory(healthyResponder),
    );
  }

  it('送ったら残る', async () => {
    await post();

    const logs = await listAuditLogsForAdmin({ entityType: 'content_item' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      // **行為者は null。** 送るのはジョブで、人が押した瞬間とは別の時刻に動く
      actorUserId: null,
      action: 'ARTICLE_POSTED',
      entityId: contentItemId,
    });
    expect(logs[0]?.metadata).toMatchObject({
      blogId: ownerBlogId,
      wpPostId: 4242,
      // **下書きであることを残す。** 公開の運用が変わっても読み方が変わらない
      wpStatus: 'DRAFT',
      created: true,
    });
  });

  it('本文を入れない', async () => {
    await post();

    const [log] = await listAuditLogsForAdmin({ entityType: 'content_item' });

    expect(JSON.stringify(log?.metadata)).not.toContain(INPUT.content);
    expect(JSON.stringify(log?.metadata)).not.toContain(INPUT.title);
  });

  /** **何も起きていないなら記録もしない**（C-5 の「内容が同じなら変えない」） */
  it('内容が同じで送り直したときは残さない', async () => {
    await post();
    await post();

    expect(
      await listAuditLogsForAdmin({ entityType: 'content_item' }),
    ).toHaveLength(1);
  });
});
