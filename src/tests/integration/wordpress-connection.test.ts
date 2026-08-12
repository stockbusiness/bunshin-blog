import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { closeBlogForUser, createBlogForUser } from '@/modules/blogs';
import {
  WORDPRESS_ERROR_CODES,
  connectWordpressForUser,
  disconnectWordpressForUser,
  findWordpressConnectionForUser,
  readWordpressCredentialsForUser,
} from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * WordPress接続情報の保存を**実PostgreSQLで**検証する（TASKS C-1）。
 *
 * 完了条件は2つ。
 * - **復号値がAPIレスポンス・ログに出ない**（SPEC 5.4・14.2）
 * - **接続後の `site_url` 変更が拒否される**（OPEN_QUESTIONS Q-007）
 *
 * あわせて、DBに平文が入っていないことを生SQLで確かめる。
 * fake DB では「実際に列へ何が書かれたか」を確認できない。
 */

const SITE_URL = 'https://monitor-blog.example.com';
const USERNAME = 'monitor-user';
const APP_PASSWORD = 'abcd EFGH ijkl MNOP qrst UVWX';

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
});

function connect(overrides: Partial<Record<string, string>> = {}) {
  return connectWordpressForUser(
    { userId: owner.id, blogId: ownerBlogId },
    {
      siteUrl: overrides['siteUrl'] ?? SITE_URL,
      wpUsername: overrides['wpUsername'] ?? USERNAME,
      appPassword: overrides['appPassword'] ?? APP_PASSWORD,
    },
  );
}

/** 生SQLで列の中身を見る。Prisma の型に頼らず、実際に入った値を確かめる */
async function readRawColumns(blogId: string): Promise<{
  site_url: string;
  wp_username_encrypted: string;
  app_password_encrypted: string;
  connection_status: string;
}> {
  const rows = await prisma.$queryRawUnsafe<
    {
      site_url: string;
      wp_username_encrypted: string;
      app_password_encrypted: string;
      connection_status: string;
    }[]
  >(
    `select site_url, wp_username_encrypted, app_password_encrypted,
            connection_status::text as connection_status
     from wordpress_connections where blog_id = $1::uuid`,
    blogId,
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('接続の行がありません');
  }

  return row;
}

describe('接続情報の保存', () => {
  it('接続を新規作成できる', async () => {
    const connection = await connect();

    expect(connection.blogId).toBe(ownerBlogId);
    expect(connection.siteUrl).toBe(SITE_URL);
    expect(connection.apiBaseUrl).toBe(`${SITE_URL}/wp-json`);
    expect(connection.connectionStatus).toBe('UNTESTED');
    expect(connection.hasCredentials).toBe(true);
  });

  it('DBの列に平文が入らない（SPEC 5.4）', async () => {
    await connect();
    const raw = await readRawColumns(ownerBlogId);

    expect(raw.wp_username_encrypted).not.toContain(USERNAME);
    expect(raw.app_password_encrypted).not.toContain('abcdEFGH');
    expect(raw.app_password_encrypted).not.toContain('abcd EFGH');
    expect(raw.wp_username_encrypted.startsWith('v1.')).toBe(true);
    expect(raw.app_password_encrypted.startsWith('v1.')).toBe(true);
  });

  it('保存した認証情報を復号して取り出せる', async () => {
    await connect();

    const credentials = await readWordpressCredentialsForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(credentials.username.expose()).toBe(USERNAME);
    expect(credentials.appPassword.expose()).toBe('abcdEFGHijklMNOPqrstUVWX');
  });

  it('APIへ返す表現に暗号文も復号値も含まれない', async () => {
    const connection = await connect();
    const serialized = JSON.stringify(connection);

    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain('abcdEFGH');
    expect(serialized).not.toContain('Encrypted');
    expect(serialized).not.toContain('v1.');
  });

  it('取得した接続にも認証情報が含まれない', async () => {
    await connect();

    const connection = await findWordpressConnectionForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(JSON.stringify(connection)).not.toContain(USERNAME);
    expect(connection?.hasCredentials).toBe(true);
  });

  it('未接続なら null を返す', async () => {
    const connection = await findWordpressConnectionForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(connection).toBeNull();
  });

  it('1ブログ1接続。再接続しても行は増えない', async () => {
    await connect();
    await connect({ appPassword: 'NEWPASSWORD1234567890abc' });

    const count = await prisma.wordpressConnection.count();
    expect(count).toBe(1);
  });
});

describe('接続先の変更（OPEN_QUESTIONS Q-007）', () => {
  beforeEach(async () => {
    await connect();
  });

  it('同一URLでの再接続は認証情報を入れ替える', async () => {
    const before = await readRawColumns(ownerBlogId);

    await connect({ appPassword: 'NEWPASSWORD1234567890abc' });

    const after = await readRawColumns(ownerBlogId);
    expect(after.app_password_encrypted).not.toBe(
      before.app_password_encrypted,
    );

    const credentials = await readWordpressCredentialsForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });
    expect(credentials.appPassword.expose()).toBe('NEWPASSWORD1234567890abc');
  });

  it('別サイトへの変更は 409 で拒否される', async () => {
    await expect(
      connect({ siteUrl: 'https://another.example.com' }),
    ).rejects.toMatchObject({
      code: WORDPRESS_ERROR_CODES.siteUrlImmutable,
      status: 409,
    });
  });

  it('拒否されたあともDBの site_url は元のまま', async () => {
    await expect(
      connect({ siteUrl: 'https://another.example.com' }),
    ).rejects.toThrow(AppError);

    expect((await readRawColumns(ownerBlogId)).site_url).toBe(SITE_URL);
  });

  it('切断しても site_url は残り、別サイトへは繋ぎ直せない', async () => {
    await disconnectWordpressForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect((await readRawColumns(ownerBlogId)).site_url).toBe(SITE_URL);

    await expect(
      connect({ siteUrl: 'https://another.example.com' }),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.siteUrlImmutable });
  });

  it('切断後に同一URLで再接続できる', async () => {
    await disconnectWordpressForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    const reconnected = await connect();

    expect(reconnected.connectionStatus).toBe('UNTESTED');
    expect(reconnected.hasCredentials).toBe(true);
  });
});

describe('切断', () => {
  beforeEach(async () => {
    await connect();
  });

  it('行を消さずに REVOKED にする', async () => {
    await disconnectWordpressForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(await prisma.wordpressConnection.count()).toBe(1);
    expect((await readRawColumns(ownerBlogId)).connection_status).toBe(
      'REVOKED',
    );
  });

  it('認証情報を空で上書きし、取り出せなくする', async () => {
    await disconnectWordpressForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    await expect(
      readWordpressCredentialsForUser({
        userId: owner.id,
        blogId: ownerBlogId,
      }),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.notConnected });
  });

  it('未接続のブログを切断しようとすると 404', async () => {
    const second = await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: '未接続',
      slug: 'not-connected',
      targetReader: '読者',
      slotNumber: 2,
    });

    await expect(
      disconnectWordpressForUser({ userId: owner.id, blogId: second.id }),
    ).rejects.toMatchObject({ code: WORDPRESS_ERROR_CODES.notConnected });
  });
});

describe('テナント分離（SPEC 14.1）', () => {
  it('他人のブログへは接続できない（404）', async () => {
    await expect(
      connectWordpressForUser(
        { userId: owner.id, blogId: otherBlogId },
        { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
      ),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });

    expect(await prisma.wordpressConnection.count()).toBe(0);
  });

  it('他人のブログの接続を読めない（404）', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    await expect(
      findWordpressConnectionForUser({
        userId: owner.id,
        blogId: otherBlogId,
      }),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });
  });

  it('他人の認証情報を復号できない（404）', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    await expect(
      readWordpressCredentialsForUser({
        userId: owner.id,
        blogId: otherBlogId,
      }),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });
  });

  it('他人のブログを切断できない（404）', async () => {
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      { siteUrl: SITE_URL, wpUsername: USERNAME, appPassword: APP_PASSWORD },
    );

    await expect(
      disconnectWordpressForUser({ userId: owner.id, blogId: otherBlogId }),
    ).rejects.toMatchObject({ code: 'BLOG_NOT_FOUND', status: 404 });

    expect((await readRawColumns(otherBlogId)).connection_status).toBe(
      'UNTESTED',
    );
  });

  it('同じサイトURLでも、別ユーザーの暗号文は取り違えられない', async () => {
    await connect();
    await connectWordpressForUser(
      { userId: other.id, blogId: otherBlogId },
      {
        siteUrl: SITE_URL,
        wpUsername: USERNAME,
        appPassword: APP_PASSWORD,
      },
    );

    const mine = await readRawColumns(ownerBlogId);
    const theirs = await readRawColumns(otherBlogId);

    // 同じ平文でも IV が異なるため暗号文は一致しない
    expect(mine.app_password_encrypted).not.toBe(theirs.app_password_encrypted);

    // 他人の行の暗号文を自分の行へ書き込んでも、AAD が合わず復号できない
    await prisma.$executeRawUnsafe(
      `update wordpress_connections
       set app_password_encrypted = $1 where blog_id = $2::uuid`,
      theirs.app_password_encrypted,
      ownerBlogId,
    );

    await expect(
      readWordpressCredentialsForUser({
        userId: owner.id,
        blogId: ownerBlogId,
      }),
    ).rejects.toMatchObject({
      code: WORDPRESS_ERROR_CODES.credentialsUnreadable,
    });
  });
});

describe('CLOSED のブログ（OPEN_QUESTIONS Q-008）', () => {
  it('CLOSED にしたブログへは接続できない', async () => {
    await closeBlogForUser({ userId: owner.id, blogId: ownerBlogId });

    await expect(connect()).rejects.toMatchObject({
      code: 'BLOG_NOT_FOUND',
      status: 404,
    });
  });
});
