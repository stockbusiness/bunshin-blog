import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { POST as createOffer, GET as listOffers } from '@/app/api/blogs/[id]/offers/route';
import {
  DELETE as endOffer,
  PATCH as patchOffer,
} from '@/app/api/blogs/[id]/offers/[offerId]/route';
import { POST as createBanner } from '@/app/api/blogs/[id]/banners/route';
import { DELETE as endBanner } from '@/app/api/blogs/[id]/banners/[bannerId]/route';
import { createBlogForUser } from '@/modules/blogs';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 案件・バナーのHTTP入口を**実PostgreSQLで**確かめる（TASKS I-3、SPEC 13.4・13.5）。
 *
 * **D-1・D-3 でモジュールは作ったが、入口が無かった**（棚卸し・2026-08-12）。
 * オンボーディング STEP 8（案件登録）が画面から完了できない状態だった。
 *
 * ここで確かめるのは、**他人のブログの案件を触れないこと**（SPEC 14.1）と、
 * **モニターに判断させない項目が入口から入らないこと**（Q-001・Q-014）。
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;

function cookieFor(userId: string): string {
  return buildSessionCookie(createSessionToken(userId, { secret: SECRET }))
    .split(';')[0] as string;
}

function request(userId: string, body?: unknown): Request {
  return new Request('https://example.test/api', {
    method: 'POST',
    headers: {
      cookie: cookieFor(userId),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function offerBody(overrides: Record<string, unknown> = {}) {
  return {
    name: '格安SIM案件',
    aspName: 'サンプルASP',
    landingPageUrl: 'https://lp.example.com/offer',
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    conversionType: 'FREE_SIGNUP',
    ...overrides,
  };
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

describe('案件の登録（オンボーディング STEP 8）', () => {
  it('作れて、一覧に出る', async () => {
    const created = await createOffer(request(owner.id, offerBody()), {
      params: Promise.resolve({ id: ownerBlogId }),
    });

    expect(created.status).toBe(201);

    const listed = await listOffers(request(owner.id), {
      params: Promise.resolve({ id: ownerBlogId }),
    });
    const body = (await listed.json()) as { offers: { name: string }[] };

    expect(body.offers.map((offer) => offer.name)).toEqual(['格安SIM案件']);
  });

  /**
   * **モニターに判断させない項目は入口から入らない**（Q-001・Q-014・Q-019）。
   * ASPの規約に関わる判断で、誤ると成果が無効になる
   */
  it.each(['linkMode', 'subIdParam', 'blogPostingProhibited', 'selectionScore'])(
    '%s は受け取らない',
    async (key) => {
      const response = await createOffer(
        request(owner.id, offerBody({ [key]: 'REDIRECT' })),
        { params: Promise.resolve({ id: ownerBlogId }) },
      );

      expect(response.status).toBe(201);

      const [row] = await prisma.affiliateOffer.findMany({
        select: { linkMode: true, subIdParam: true, blogPostingProhibited: true },
      });

      // 既定のまま（Q-001 の「安全側は DIRECT」）
      expect(row).toMatchObject({
        linkMode: 'DIRECT',
        subIdParam: null,
        blogPostingProhibited: false,
      });
    },
  );

  it('内容が不正なら422', async () => {
    const response = await createOffer(
      request(owner.id, offerBody({ conversionType: 'UNKNOWN' })),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(response.status).toBe(422);
  });
});

/** **他人のブログは 403 ではなく 404**（IDの総当たりで存在を調べられない） */
describe('テナント分離（SPEC 14.1）', () => {
  it('他人のブログに案件を作れない', async () => {
    const response = await createOffer(request(other.id, offerBody()), {
      params: Promise.resolve({ id: ownerBlogId }),
    });

    expect(response.status).toBe(404);
    expect(await prisma.affiliateOffer.count()).toBe(0);
  });

  it('他人のブログの案件は一覧に出ない', async () => {
    await createOffer(request(owner.id, offerBody()), {
      params: Promise.resolve({ id: ownerBlogId }),
    });

    const listed = await listOffers(request(other.id), {
      params: Promise.resolve({ id: otherBlogId }),
    });
    const body = (await listed.json()) as { offers: unknown[] };

    expect(body.offers).toEqual([]);
  });

  /**
   * **`affiliate_offers.id` は全ブログで一意。** ブログ配下の経路に
   * したのは、IDだけで引くと他ブログの案件が取れるため
   */
  it('他人の案件IDを自分のブログ配下で更新できない', async () => {
    const created = await createOffer(request(owner.id, offerBody()), {
      params: Promise.resolve({ id: ownerBlogId }),
    });
    const { offer } = (await created.json()) as { offer: { id: string } };

    const response = await patchOffer(request(other.id, { name: '書き換え' }), {
      params: Promise.resolve({ id: otherBlogId, offerId: offer.id }),
    });

    expect(response.status).toBe(404);
    expect(
      (await prisma.affiliateOffer.findUniqueOrThrow({
        where: { id: offer.id },
        select: { name: true },
      })).name,
    ).toBe('格安SIM案件');
  });
});

/**
 * **物理削除しない。** 記事に埋め込んだリンクが残っており、
 * 成果の紐付けも過去分を参照する（D-1・D-3）
 */
describe('削除は終了にする', () => {
  it('案件は ENDED になり、行は残る', async () => {
    const created = await createOffer(request(owner.id, offerBody()), {
      params: Promise.resolve({ id: ownerBlogId }),
    });
    const { offer } = (await created.json()) as { offer: { id: string } };

    await endOffer(request(owner.id), {
      params: Promise.resolve({ id: ownerBlogId, offerId: offer.id }),
    });

    expect(
      (await prisma.affiliateOffer.findUniqueOrThrow({
        where: { id: offer.id },
        select: { status: true },
      })).status,
    ).toBe('ENDED');
  });

  it('バナーも ENDED になり、行は残る', async () => {
    const created = await createBanner(
      request(owner.id, {
        name: 'トップバナー',
        imageUrl: 'https://img.example.com/a.png',
        destinationUrl: 'https://lp.example.com/offer',
        slot: 'TOP',
      }),
      { params: Promise.resolve({ id: ownerBlogId }) },
    );

    expect(created.status).toBe(201);

    const { banner } = (await created.json()) as { banner: { id: string } };

    await endBanner(request(owner.id), {
      params: Promise.resolve({ id: ownerBlogId, bannerId: banner.id }),
    });

    expect(
      (await prisma.banner.findUniqueOrThrow({
        where: { id: banner.id },
        select: { status: true },
      })).status,
    ).toBe('ENDED');
  });
});
