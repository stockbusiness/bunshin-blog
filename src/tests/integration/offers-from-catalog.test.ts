import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  GET as listCatalog,
  POST as addFromCatalog,
} from '@/app/api/blogs/[blogId]/offers/catalog/route';
import {
  createCatalogItemForAdmin,
  listOffersNeedingFactCheckForUser,
  updateCatalogItemForAdmin,
  type CatalogItemInput,
} from '@/modules/affiliate';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 候補から案件を登録する（Q-058・Q-055、段8）。
 *
 * 守りたいのは3つ。
 *
 * 1. **クライアントの値を信じない。** 名前も報酬額も事実も
 *    サーバーがカタログから読む。渡させると
 *    **カタログを選んだのに中身は別物**という行が作れる
 * 2. **ASPの規約の判断はカタログが持つ**（`link_mode`・`sub_id_param`）。
 *    モニターが決めてよいものではない
 * 3. **確かめた時刻はカタログのものを引き継ぐ。** 今の時刻を入れると
 *    モニターが確かめたことになり、`null` だと運営が確かめたのに未確認になる
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let adminId: string;
let userId: string;
let otherUserId: string;
let blogId: string;

function request(userId: string, body?: unknown): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ blogId: id }) };
}

function catalogInput(
  overrides: Partial<CatalogItemInput> = {},
): CatalogItemInput {
  return {
    name: '格安SIM A',
    aspName: 'テストASP',
    landingPageUrl: 'https://lp.example.com/a',
    conversionType: 'FREE_SIGNUP',
    rewardYen: 1_480,
    facts: ['月額1,480円'],
    linkMode: 'REDIRECT',
    subIdParam: 'sub',
    status: 'ACTIVE',
    ...overrides,
  };
}

async function activeItem(
  overrides: Partial<CatalogItemInput> = {},
): Promise<string> {
  const created = await createCatalogItemForAdmin(
    catalogInput(overrides),
    adminId,
  );

  return created.id;
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
  userId = monitor.id;
  blogId = (await createBlog(prisma, monitor.id)).id;

  const other = await createUser(prisma, { displayName: 'ほかの人' });
  otherUserId = other.id;
  await createBlog(prisma, other.id);
});

describe('候補を出す', () => {
  it('選べるものだけ出る', async () => {
    await activeItem();
    await createCatalogItemForAdmin(
      catalogInput({
        name: '下書き',
        landingPageUrl: 'https://lp.example.com/draft',
        status: 'DRAFT',
      }),
      adminId,
    );

    const response = await listCatalog(request(userId), ctx(blogId));
    const body = (await response.json()) as { items: { name: string }[] };

    expect(body.items.map((item) => item.name)).toEqual(['格安SIM A']);
  });

  /**
   * **リンクの出し方はモニターに出さない。** 運営の判断で、
   * 変えられるものではない（Q-001・Q-014）
   */
  it('ASPの規約に関わる値を返さない', async () => {
    await activeItem();

    const response = await listCatalog(request(userId), ctx(blogId));
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
    };

    expect(body.items[0]).not.toHaveProperty('linkMode');
    expect(body.items[0]).not.toHaveProperty('subIdParam');
  });

  it('他人のブログでは見られない', async () => {
    await activeItem();

    const response = await listCatalog(request(otherUserId), ctx(blogId));

    expect(response.status).toBe(404);
  });
});

describe('候補から登録する', () => {
  async function add(
    itemId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    return addFromCatalog(
      request(userId, {
        catalogItemId: itemId,
        affiliateUrl: 'https://asp.example.com/click?a=1',
        userExperience: 'USED',
        ...overrides,
      }),
      ctx(blogId),
    );
  }

  it('登録できる', async () => {
    const itemId = await activeItem();

    expect((await add(itemId)).status).toBe(201);

    const row = await prisma.affiliateOffer.findFirstOrThrow();

    expect(row.name).toBe('格安SIM A');
    expect(row.catalogItemId).toBe(itemId);
    expect(row.affiliateUrl).toBe('https://asp.example.com/click?a=1');
    expect(row.userExperience).toBe('USED');
  });

  /**
   * **カタログを選んだのに中身は別物、という行を作らせない。**
   * 名前も報酬額も事実も、サーバーがカタログから読む。
   */
  it('クライアントが送った名前や報酬額を使わない', async () => {
    const itemId = await activeItem();

    await add(itemId, {
      name: 'にせの名前',
      rewardYen: 999_999,
      facts: ['にせの事実'],
      landingPageUrl: 'https://evil.example.com/',
    });

    const row = await prisma.affiliateOffer.findFirstOrThrow();

    expect(row.name).toBe('格安SIM A');
    expect(row.rewardYen).toBe(1_480);
    expect(row.facts).toEqual(['月額1,480円']);
    expect(row.landingPageUrl).toBe('https://lp.example.com/a');
  });

  /** **ASPの規約の判断はカタログが持つ**（Q-001・Q-014・Q-019） */
  it('リンクの出し方はカタログから引き継ぐ', async () => {
    const itemId = await activeItem();

    await add(itemId, { linkMode: 'DIRECT', subIdParam: 'のっとり' });

    const row = await prisma.affiliateOffer.findFirstOrThrow();

    expect(row.linkMode).toBe('REDIRECT');
    expect(row.subIdParam).toBe('sub');
  });

  /**
   * **確かめたのは運営。** 今の時刻を入れるとモニターが確かめたことになり、
   * `null` だと運営が確かめたのに未確認になる（D-13・Q-022）。
   */
  it('確かめた時刻はカタログのものを引き継ぐ', async () => {
    const itemId = await activeItem();
    const item = await prisma.offerCatalogItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { factsUpdatedAt: true },
    });

    await add(itemId);

    const row = await prisma.affiliateOffer.findFirstOrThrow();

    expect(row.factsUpdatedAt?.toISOString()).toBe(
      item.factsUpdatedAt?.toISOString(),
    );
  });

  /** **引き継いだ直後は警告が出ない。** 元が新しくなったときだけ出る */
  it('登録直後は「確かめてください」が出ない', async () => {
    const itemId = await activeItem();
    await add(itemId);

    expect(await listOffersNeedingFactCheckForUser({ userId, blogId })).toEqual(
      [],
    );

    await updateCatalogItemForAdmin(
      itemId,
      catalogInput({ facts: ['月額980円'] }),
      adminId,
    );

    expect(
      await listOffersNeedingFactCheckForUser({ userId, blogId }),
    ).toHaveLength(1);
  });

  /** **一覧に出していないものを、IDだけで登録させない** */
  it('下書きの案件は登録できない', async () => {
    const created = await createCatalogItemForAdmin(
      catalogInput({ status: 'DRAFT' }),
      adminId,
    );

    const response = await add(created.id);

    expect(response.status).toBe(409);
    expect(await prisma.affiliateOffer.count()).toBe(0);
  });

  it('掲載禁止の案件は登録できない', async () => {
    const itemId = await activeItem();
    await updateCatalogItemForAdmin(
      itemId,
      catalogInput({ blogPostingProhibited: true }),
      adminId,
    );

    const response = await add(itemId);

    expect(response.status).toBe(409);
  });

  it('無い案件は404', async () => {
    const response = await add('00000000-0000-4000-8000-000000000000');

    expect(response.status).toBe(404);
  });

  it('他人のブログには登録できない', async () => {
    const itemId = await activeItem();

    const response = await addFromCatalog(
      request(otherUserId, {
        catalogItemId: itemId,
        affiliateUrl: 'https://asp.example.com/click?a=1',
        userExperience: 'USED',
      }),
      ctx(blogId),
    );

    expect(response.status).toBe(404);
    expect(await prisma.affiliateOffer.count()).toBe(0);
  });

  /** **使ったことがあるかは省けない**（MANUAL 段8） */
  it('使用経験が無ければ断る', async () => {
    const itemId = await activeItem();

    const response = await addFromCatalog(
      request(userId, {
        catalogItemId: itemId,
        affiliateUrl: 'https://asp.example.com/click?a=1',
      }),
      ctx(blogId),
    );

    expect(response.status).toBe(422);
  });

  it('リンクがURLでなければ断る', async () => {
    const itemId = await activeItem();

    const response = await add(itemId, { affiliateUrl: 'ただの文字列' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.affiliateOffer.count()).toBe(0);
  });
});

describe('同じ案件を2つのブログで使う', () => {
  it('別々の行になり、リンクはそれぞれのもの', async () => {
    const itemId = await activeItem();

    await addFromCatalog(
      request(userId, {
        catalogItemId: itemId,
        affiliateUrl: 'https://asp.example.com/click?a=1',
        userExperience: 'USED',
      }),
      ctx(blogId),
    );

    const second = (await createBlog(prisma, userId, { slotNumber: 2 })).id;

    await addFromCatalog(
      request(userId, {
        catalogItemId: itemId,
        affiliateUrl: 'https://asp.example.com/click?a=2',
        userExperience: 'NOT_USED',
      }),
      ctx(second),
    );

    const rows = await prisma.affiliateOffer.findMany({
      orderBy: { affiliateUrl: 'asc' },
      select: { affiliateUrl: true, catalogItemId: true, userExperience: true },
    });

    expect(rows).toHaveLength(2);
    // **元は同じ。** 事実の出どころが1つになる（Q-055）
    expect(rows[0]?.catalogItemId).toBe(rows[1]?.catalogItemId);
    expect(rows[0]?.affiliateUrl).not.toBe(rows[1]?.affiliateUrl);
    expect(rows[0]?.userExperience).not.toBe(rows[1]?.userExperience);
  });
});
