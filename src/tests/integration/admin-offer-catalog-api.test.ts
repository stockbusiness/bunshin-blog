import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  GET as listCatalog,
  POST as addCatalogItem,
} from '@/app/api/admin/offer-catalog/route';
import { PUT as editCatalogItem } from '@/app/api/admin/offer-catalog/[itemId]/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 案件カタログの入口（Q-055）を**実PostgreSQLで**確かめる。
 *
 * **ADMIN 以外に開いていない**ことを見る。
 * `link_mode`・`sub_id_param`・`blog_posting_prohibited` は
 * **ASPの規約の判断**（Q-001・Q-014・Q-019）で、モニターが決めるものではない。
 * `facts` は**30ブログすべての記事に広がる。**
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let adminId: string;
let monitorId: string;

function request(userId: string, method: string, body?: unknown): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api/admin/offer-catalog', {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function body(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: '格安SIM A',
    aspName: 'テストASP',
    landingPageUrl: 'https://lp.example.com/a',
    conversionType: 'FREE_SIGNUP',
    facts: ['月額1,480円'],
    ...overrides,
  };
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

  const admin = await createUser(prisma, { displayName: '管理者' });
  await prisma.user.update({
    where: { id: admin.id },
    data: { role: 'ADMIN' },
  });
  adminId = admin.id;

  const monitor = await createUser(prisma, { displayName: 'モニター' });
  monitorId = monitor.id;
});

describe('ADMIN 以外に開かない', () => {
  it('モニターは読めない', async () => {
    expect((await listCatalog(request(monitorId, 'GET'))).status).toBe(403);
  });

  /** **モニターがASPの規約判断を書けてはいけない** */
  it('モニターは足せない', async () => {
    const response = await addCatalogItem(request(monitorId, 'POST', body()));

    expect(response.status).toBe(403);
    expect(await prisma.offerCatalogItem.count()).toBe(0);
  });

  it('ログインしていなければ読めない', async () => {
    const response = await listCatalog(
      new Request('https://example.test/api/admin/offer-catalog'),
    );

    expect(response.status).toBe(401);
  });
});

describe('足して直す', () => {
  it('足して読み直せる', async () => {
    const created = await addCatalogItem(request(adminId, 'POST', body()));

    expect(created.status).toBe(201);

    const listed = await listCatalog(request(adminId, 'GET'));
    const payload = (await listed.json()) as { items: { name: string }[] };

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.name).toBe('格安SIM A');
  });

  it('直せる', async () => {
    const created = await addCatalogItem(request(adminId, 'POST', body()));
    const { item } = (await created.json()) as { item: { id: string } };

    const response = await editCatalogItem(
      request(adminId, 'PUT', body({ name: '名前を直した' })),
      { params: Promise.resolve({ itemId: item.id }) },
    );

    expect(response.status).toBe(200);
  });

  it('モニターは直せない', async () => {
    const created = await addCatalogItem(request(adminId, 'POST', body()));
    const { item } = (await created.json()) as { item: { id: string } };

    const response = await editCatalogItem(
      request(monitorId, 'PUT', body({ name: '横取り' })),
      { params: Promise.resolve({ itemId: item.id }) },
    );

    expect(response.status).toBe(403);
  });

  it('紹介先がURLでなければ断る', async () => {
    const response = await addCatalogItem(
      request(adminId, 'POST', body({ landingPageUrl: 'ただの文字列' })),
    );

    expect(response.status).toBe(422);
  });

  /** **同じものを二度登録しない** */
  it('同じ ASP と紹介先は断る', async () => {
    await addCatalogItem(request(adminId, 'POST', body()));

    const response = await addCatalogItem(request(adminId, 'POST', body()));

    expect(response.status).toBe(409);
  });

  it('見つからない案件は 404', async () => {
    const response = await editCatalogItem(request(adminId, 'PUT', body()), {
      params: Promise.resolve({
        itemId: '00000000-0000-4000-8000-000000000000',
      }),
    });

    expect(response.status).toBe(404);
  });
});
