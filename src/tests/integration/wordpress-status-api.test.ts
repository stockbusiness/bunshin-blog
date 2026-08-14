import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GET as getConnection } from '@/app/api/blogs/[blogId]/wordpress/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import { createBlogForUser } from '@/modules/blogs';
import { connectWordpressForUser } from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * `GET /api/blogs/:blogId/wordpress` を**実PostgreSQLで**確かめる（C-1）。
 *
 * **繋ぐ・試す・切るはあったが、状態を聞く入口が無かった**（Q-048）。
 * 段6の画面は、繋ぐ前と繋いだ後で出すものが違う。**聞けないと、
 * 繋いだ後にもう一度繋ぐ画面を出すことになる。**
 *
 * ここで確かめるのは2つ。
 * - **他人のブログの接続を覗けないこと**（SPEC 14.1）
 * - **認証情報が応答に出ないこと**（SPEC 5.4・14.2）
 */

const SECRET = 'a'.repeat(48);
const SITE_URL = 'https://monitor-blog.example.com';
const USERNAME = 'monitor-user';
const APP_PASSWORD = 'abcd EFGH ijkl MNOP qrst UVWX';

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;

function request(userId: string): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api', { headers: { cookie } });
}

async function createBlog(userId: string, slug: string): Promise<string> {
  const persona = await createPersona(prisma, userId);
  const blog = await createBlogForUser(userId, {
    personaId: persona.id,
    name: 'ブログ',
    slug,
    targetReader: '読者',
  });

  return blog.id;
}

beforeAll(async () => {
  process.env['SESSION_SECRET'] = SECRET;
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
  ownerBlogId = await createBlog(owner.id, 'owner-blog');
  otherBlogId = await createBlog(other.id, 'other-blog');
});

describe('接続の状態を聞く', () => {
  /** **未接続を失敗にしない。** 繋ぐ前の正常な状態である */
  it('繋いでいなければ null を返す', async () => {
    const response = await getConnection(request(owner.id), {
      params: Promise.resolve({ blogId: ownerBlogId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
  });

  it('繋いでいれば、サイトURLと状態を返す', async () => {
    await connectWordpressForUser(
      { userId: owner.id, blogId: ownerBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    const response = await getConnection(request(owner.id), {
      params: Promise.resolve({ blogId: ownerBlogId }),
    });
    const body = (await response.json()) as {
      connection: { siteUrl: string; hasCredentials: boolean };
    };

    expect(body.connection.siteUrl).toBe(SITE_URL);
    // **繋いだだけでは `CONNECTED` にならない**（接続テストが付ける）
    expect(body.connection).toMatchObject({
      connectionStatus: 'UNTESTED',
      hasCredentials: true,
    });
  });

  /** **応答に認証情報を混ぜない**（SPEC 5.4・14.2） */
  it('パスワードも利用者名も応答に出ない', async () => {
    await connectWordpressForUser(
      { userId: owner.id, blogId: ownerBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    const response = await getConnection(request(owner.id), {
      params: Promise.resolve({ blogId: ownerBlogId }),
    });
    const text = await response.text();

    expect(text).not.toContain(APP_PASSWORD);
    expect(text).not.toContain(APP_PASSWORD.replace(/ /g, ''));
    expect(text).not.toContain(USERNAME);
  });

  /** **他人のブログは「無い」として返す**（存在を教えない・B-3） */
  it('他人のブログは 404', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    const response = await getConnection(request(owner.id), {
      params: Promise.resolve({ blogId: otherBlogId }),
    });

    expect(response.status).toBe(404);
  });

  it('ログインしていなければ 401', async () => {
    const response = await getConnection(
      new Request('https://example.test/api'),
      { params: Promise.resolve({ blogId: ownerBlogId }) },
    );

    expect(response.status).toBe(401);
  });
});
