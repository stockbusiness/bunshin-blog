import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GET as authorized } from '@/app/api/blogs/[id]/wordpress/authorized/route';
import { POST as authorize } from '@/app/api/blogs/[id]/wordpress/authorize/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import { createAuthorizeState } from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * WordPress の認可フローを**実PostgreSQLで**確かめる（TASKS I-8、SPEC 7.1）。
 *
 * **モニターは自分の WordPress で「承認」を1回押すだけ**になる
 * （`MANUAL.md` 段6 の発行・コピー・貼り付けが消える）。
 *
 * ここで確かめるのは、**細工した戻りを受け付けないこと。**
 * 署名と照合が甘いと、**攻撃者のサイトを他人のブログ枠につながせられる。**
 */

const SECRET = 'a'.repeat(48);
const SITE = 'https://example.com';
const APP_BASE_URL = 'https://bunshin.example';

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;

function cookieFor(userId: string): string {
  return buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;
}

function callbackRequest(
  userId: string,
  query: Record<string, string>,
): Request {
  const url = new URL(`${APP_BASE_URL}/api/blogs/x/wordpress/authorized`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return new Request(url, { headers: { cookie: cookieFor(userId) } });
}

function stateFor(params: {
  userId: string;
  blogId: string;
  siteUrl?: string;
}): string {
  return createAuthorizeState(
    {
      userId: params.userId,
      blogId: params.blogId,
      siteUrl: params.siteUrl ?? SITE,
    },
    { secret: SECRET },
  );
}

/** 承認が通ったときに WordPress が付けてくる値 */
function approved(state: string, overrides: Record<string, string> = {}) {
  return {
    state,
    site_url: SITE,
    user_login: 'monitor',
    password: 'abcd efgh ijkl mnop qrst uvwx',
    ...overrides,
  };
}

function connectionCount(): Promise<number> {
  return prisma.wordpressConnection.count();
}

beforeAll(async () => {
  process.env['SESSION_SECRET'] = SECRET;
  process.env['APP_BASE_URL'] = APP_BASE_URL;
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  owner = await createUser(prisma);
  other = await createUser(prisma);
  ownerBlogId = (await createBlog(prisma, owner.id, { name: '自分' })).id;
  otherBlogId = (await createBlog(prisma, other.id, { name: '他人' })).id;
});

describe('承認画面へ送る', () => {
  it('WordPress の承認画面のURLを返す', async () => {
    const response = await authorize(
      new Request(`${APP_BASE_URL}/api`, {
        method: 'POST',
        headers: {
          cookie: cookieFor(owner.id),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ siteUrl: SITE }),
      }),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(response.status).toBe(200);

    const { authorizeUrl } = (await response.json()) as {
      authorizeUrl: string;
    };
    const url = new URL(authorizeUrl);

    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe('/wp-admin/authorize-application.php');
    // **戻り先は APP_BASE_URL から作る**（リクエストの Host から作らない）
    expect(url.searchParams.get('success_url')).toBe(
      `${APP_BASE_URL}/api/blogs/${ownerBlogId}/wordpress/authorized`,
    );
  });

  /**
   * **確かめずに `state` を発行すると、署名付きの依頼そのものが
   * 他人のブログを指せる**
   */
  it('他人のブログには発行しない', async () => {
    const response = await authorize(
      new Request(`${APP_BASE_URL}/api`, {
        method: 'POST',
        headers: {
          cookie: cookieFor(other.id),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ siteUrl: SITE }),
      }),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(response.status).toBe(404);
  });
});

describe('承認から戻る', () => {
  it('つながって、画面へ戻る', async () => {
    const response = await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: ownerBlogId })),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(response.status).toBe(302);

    // **クエリを落としたURLへ即座に転送する**（履歴・Referer・
    // アクセスログにパスワードが残る時間を短くする）
    const location = new URL(response.headers.get('location') as string);

    expect(location.pathname).toBe(`/liff/blogs/${ownerBlogId}/wordpress`);
    expect(location.searchParams.get('authorize')).toBe('connected');
    expect(location.search).not.toContain('password');

    expect(await connectionCount()).toBe(1);
  });

  it('保存された接続は手で貼ったときと同じ', async () => {
    await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: ownerBlogId })),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    const connection = await prisma.wordpressConnection.findFirstOrThrow({
      select: { blogId: true, siteUrl: true, connectionStatus: true },
    });

    expect(connection).toMatchObject({ blogId: ownerBlogId, siteUrl: SITE });
  });

  /** **接続変更は監査ログに残る**（H-12）。経路が増えても同じ */
  it('監査ログに残る', async () => {
    await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: ownerBlogId })),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    const logs = await prisma.auditLog.findMany({
      where: { action: 'WORDPRESS_CONNECTED' },
      select: { metadata: true },
    });

    expect(logs).toHaveLength(1);
    // **認証情報は監査ログに入れない**（SPEC 14.2）
    expect(JSON.stringify(logs[0]?.metadata)).not.toContain('abcd');
  });
});

describe('受け付けない戻り', () => {
  /** **押し間違い。** 失敗ではなく「拒否」として画面へ戻す */
  it('拒否して戻ってきたら、つながない', async () => {
    const response = await authorized(
      callbackRequest(owner.id, {
        state: stateFor({ userId: owner.id, blogId: ownerBlogId }),
      }),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(
      new URL(response.headers.get('location') as string).searchParams.get(
        'authorize',
      ),
    ).toBe('rejected');
    expect(await connectionCount()).toBe(0);
  });

  /**
   * **署名は「Bunshin が出した依頼」であることしか示さない。**
   * 自分の別のブログ枠へ差し替えられるのを止めるのは、この照合
   */
  it('自分の別のブログ宛の state を使えない', async () => {
    const secondBlog = (
      await createBlog(prisma, owner.id, { name: '2つめ', slotNumber: 2 })
    ).id;

    const response = await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: secondBlog })),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(
      new URL(response.headers.get('location') as string).searchParams.get(
        'authorize',
      ),
    ).toBe('failed');
    expect(await connectionCount()).toBe(0);
  });

  it('他人が発行した state を使えない', async () => {
    const response = await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: other.id, blogId: otherBlogId })),
      ),
      { params: Promise.resolve({ id: otherBlogId }) },
    );

    expect(await connectionCount()).toBe(0);
    expect(response.status).toBe(302);
  });

  /** **依頼したのと違うサイトの資格情報を受け取らない** */
  it('違うサイトで承認されたものを受け付けない', async () => {
    const response = await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: ownerBlogId }), {
          site_url: 'https://evil.example',
        }),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(
      new URL(response.headers.get('location') as string).searchParams.get(
        'authorize',
      ),
    ).toBe('failed');
    expect(await connectionCount()).toBe(0);
  });

  /** **確かめられないまま繋ぐと、署名だけが根拠になる** */
  it('サイトURLが載っていないものを受け付けない', async () => {
    await authorized(
      callbackRequest(
        owner.id,
        approved(stateFor({ userId: owner.id, blogId: ownerBlogId }), {
          site_url: '',
        }),
      ),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(await connectionCount()).toBe(0);
  });

  it('署名を偽ったものを受け付けない', async () => {
    const forged = createAuthorizeState(
      { userId: owner.id, blogId: ownerBlogId, siteUrl: SITE },
      { secret: 'b'.repeat(48) },
    );

    await authorized(callbackRequest(owner.id, approved(forged)), {
      params: Promise.resolve({ id: ownerBlogId }) as Promise<{ id: string }>,
    });

    expect(await connectionCount()).toBe(0);
  });

  /** **どのブログの話かを名乗る前に、まずログインしてもらう** */
  it('セッションが無ければ画面へ戻さない', async () => {
    const url = new URL(
      `${APP_BASE_URL}/api/blogs/x/wordpress/authorized?state=x&password=y`,
    );

    const response = await authorized(new Request(url), {
      params: Promise.resolve({ id: ownerBlogId }),
    });

    expect(response.status).toBe(401);
  });
});
