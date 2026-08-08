import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  WORDPRESS_TEST_ERROR_CODES,
  connectWordpressForUser,
  disconnectWordpressForUser,
  findWordpressConnectionForUser,
  testWordpressConnectionForUser,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressCredentials,
  type WordpressRequest,
} from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 接続テストの結果が**実PostgreSQLへ保存される**ことを確かめる（C-2）。
 *
 * 7項目の判定そのものは `src/tests/modules/wordpress/connection-test.test.ts`
 * の担当。ここで見るのは保存と所有権。
 *
 * WordPress へは実際に繋がないため、クライアントを差し替える。
 * **認証情報の復号は本物**（C-1 の経路をそのまま通る）。
 */

const SITE_URL = 'https://monitor-blog.example.com';

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  owner = await createUser(prisma, { displayName: '所有者' });
  other = await createUser(prisma, { displayName: '別ユーザー' });

  const ownerBlog = await createBlogForUser(owner.id, {
    name: '自分のブログ',
    slug: 'mine',
    targetReader: '読者',
    slotNumber: 1,
  });
  const otherBlog = await createBlogForUser(other.id, {
    name: '他人のブログ',
    slug: 'theirs',
    targetReader: '読者',
    slotNumber: 1,
  });

  ownerBlogId = ownerBlog.id;
  otherBlogId = otherBlog.id;

  await connectWordpressForUser(
    { userId: owner.id, blogId: ownerBlogId },
    {
      siteUrl: SITE_URL,
      wpUsername: 'monitor01',
      appPassword: 'abcd EFGH ijkl MNOP qrst UVWX',
    },
  );
});

interface SeenCredentials {
  username: string;
  appPassword: string;
}

/** 全て成功する WordPress を模したクライアントを作る */
function createFactory(
  responder: (input: WordpressRequest) => Partial<WordpressApiResponse>,
  seen?: SeenCredentials[],
) {
  return (input: {
    apiBaseUrl: string;
    credentials: WordpressCredentials;
  }): WordpressClient => {
    seen?.push({
      username: input.credentials.username.expose(),
      appPassword: input.credentials.appPassword.expose(),
    });

    return {
      async request(request) {
        const result = responder(request);

        return {
          status: result.status ?? 200,
          headers: result.headers ?? {},
          json: result.json ?? null,
          raw: JSON.stringify(result.json ?? null),
        };
      },
    };
  };
}

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
    return { status: 201, json: { id: 7, status: 'draft' } };
  }
  if (method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

describe('接続テストの結果を保存する', () => {
  it('成功したら CONNECTED にして権限を保存する', async () => {
    const result = await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory(healthyResponder),
    );

    expect(result.ok).toBe(true);

    const connection = await findWordpressConnectionForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(connection).toMatchObject({
      connectionStatus: 'CONNECTED',
      canCreatePosts: true,
      canEditPosts: true,
      canUploadMedia: true,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    expect(connection?.lastTestedAt).not.toBeNull();
  });

  it('失敗したら FAILED にして項目のコードを保存する', async () => {
    const result = await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory((input) =>
        input.path.startsWith('/wp/v2/users/me')
          ? {
              status: 401,
              json: {
                code: 'incorrect_password',
                message: 'パスワードが違います',
                data: { status: 401 },
              },
            }
          : healthyResponder(input),
      ),
    );

    expect(result.ok).toBe(false);

    const connection = await findWordpressConnectionForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(connection).toMatchObject({
      connectionStatus: 'FAILED',
      canCreatePosts: false,
      canEditPosts: false,
      canUploadMedia: false,
      lastErrorCode: WORDPRESS_TEST_ERROR_CODES.authFailed,
    });
    expect(connection?.lastErrorMessage).toContain('パスワードが違います');
  });

  it('一度成功したあとに失敗すると CONNECTED から FAILED へ戻る', async () => {
    await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory(healthyResponder),
    );

    await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory((input) =>
        input.path === '/'
          ? { status: 500, json: {} }
          : healthyResponder(input),
      ),
    );

    const connection = await findWordpressConnectionForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(connection?.connectionStatus).toBe('FAILED');
    expect(connection?.canCreatePosts).toBe(false);
  });

  it('保存した認証情報を復号してクライアントへ渡す', async () => {
    const seen: SeenCredentials[] = [];

    await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory(healthyResponder, seen),
    );

    expect(seen[0]).toEqual({
      username: 'monitor01',
      // 空白は保存時に除去されている（C-1）
      appPassword: 'abcdEFGHijklMNOPqrstUVWX',
    });
  });

  it('結果に認証情報が含まれない', async () => {
    const result = await testWordpressConnectionForUser(
      { userId: owner.id, blogId: ownerBlogId },
      createFactory(healthyResponder),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('monitor01');
    expect(serialized).not.toContain('abcdEFGH');
  });
});

describe('前提が整っていない場合', () => {
  it('未接続のブログは 404', async () => {
    const second = await createBlogForUser(owner.id, {
      name: '未接続',
      slug: 'not-connected',
      targetReader: '読者',
      slotNumber: 2,
    });

    await expect(
      testWordpressConnectionForUser(
        { userId: owner.id, blogId: second.id },
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'WORDPRESS_NOT_CONNECTED', status: 404 });
  });

  it('切断済みなら 404', async () => {
    await disconnectWordpressForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    await expect(
      testWordpressConnectionForUser(
        { userId: owner.id, blogId: ownerBlogId },
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'WORDPRESS_NOT_CONNECTED' });
  });
});

describe('テナント分離（SPEC 14.1）', () => {
  it('他人のブログはテストできない（404）', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      {
        siteUrl: SITE_URL,
        wpUsername: 'other-user',
        appPassword: 'zzzzzzzzzzzzzzzzzzzz',
      },
    );

    await expect(
      testWordpressConnectionForUser(
        { userId: owner.id, blogId: otherBlogId },
        createFactory(healthyResponder),
      ),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });
  });

  it('拒否された場合、他人の接続状態は変わらない', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      {
        siteUrl: SITE_URL,
        wpUsername: 'other-user',
        appPassword: 'zzzzzzzzzzzzzzzzzzzz',
      },
    );

    await expect(
      testWordpressConnectionForUser(
        { userId: owner.id, blogId: otherBlogId },
        createFactory(healthyResponder),
      ),
    ).rejects.toThrow();

    const theirs = await findWordpressConnectionForUser({
      userId: other.id,
      blogId: otherBlogId,
    });

    expect(theirs?.connectionStatus).toBe('UNTESTED');
    expect(theirs?.lastTestedAt).toBeNull();
  });
});
