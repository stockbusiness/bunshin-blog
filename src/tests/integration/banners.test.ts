import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createOfferForUser } from '@/modules/affiliate';
import {
  createBannerForUser,
  endBannerForUser,
  findBannerForUser,
  listBannersForUser,
  requireBannerForUser,
  updateBannerForUser,
  type CreateBannerInput,
} from '@/modules/banners';
import { createBlogForUser } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * バナーが**ブログ別に分離され、指定した内容で保存される**ことを
 * 実PostgreSQLで確かめる（TASKS D-3）。
 *
 * 完了条件は「**表示位置・対象カテゴリ・有効期間が保存される**」。
 *
 * 加えて、**紐づける案件が同じブログのものか**を確かめる。C-6 で
 * `wordpress_posts` に同じ形の穴が見つかっており、ここは所有モジュール
 * （`affiliate`）が既にあるので実装側で塞げる。
 */

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;

function input(overrides: Partial<CreateBannerInput> = {}): CreateBannerInput {
  return {
    name: 'サンプルバナー',
    imageUrl: 'https://cdn.example.com/banner.png',
    destinationUrl: 'https://asp.example/click?a=xxxx',
    slot: 'TOP',
    ...overrides,
  };
}

async function createOffer(userId: string, blogId: string): Promise<string> {
  const offer = await createOfferForUser(
    { userId, blogId },
    {
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://lp.example.com/offer',
      affiliateUrl: 'https://asp.example/click?a=xxxx',
      conversionType: 'FREE_SIGNUP',
    },
  );

  return offer.id;
}

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

  blog1 = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: 'ブログ1',
      slug: 'mine-1',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  blog2 = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: 'ブログ2',
      slug: 'mine-2',
      targetReader: '読者',
      slotNumber: 2,
    })
  ).id;
  otherBlog = (
    await createBlogForUser(other.id, {
      personaId: (await createPersona(prisma, other.id)).id,
      name: '他人のブログ',
      slug: 'theirs',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
});

describe('登録（完了条件）', () => {
  it('表示位置・対象カテゴリ・有効期間が保存される', async () => {
    const startsAt = new Date('2026-08-01T00:00:00Z');
    const endsAt = new Date('2026-09-01T00:00:00Z');

    const banner = await createBannerForUser(
      { userId: owner.id, blogId: blog1 },
      input({
        slot: 'AFTER_FIRST_HEADING',
        targetCategories: ['美容', '健康'],
        startsAt,
        endsAt,
      }),
    );

    expect(banner).toMatchObject({
      blogId: blog1,
      slot: 'AFTER_FIRST_HEADING',
      targetCategories: ['美容', '健康'],
      status: 'ACTIVE',
    });
    expect(banner.startsAt?.toISOString()).toBe(startsAt.toISOString());
    expect(banner.endsAt?.toISOString()).toBe(endsAt.toISOString());

    // **配列が実際に保存されているか**（Prisma の String[] は取り違えやすい）
    const row = await prisma.banner.findUniqueOrThrow({
      where: { id: banner.id },
      select: { targetCategories: true, slot: true },
    });
    expect(row.targetCategories).toEqual(['美容', '健康']);
    expect(row.slot).toBe('AFTER_FIRST_HEADING');
  });

  it('対象カテゴリ未指定なら空（全ての記事が対象）', async () => {
    const banner = await createBannerForUser(
      { userId: owner.id, blogId: blog1 },
      input(),
    );

    expect(banner.targetCategories).toEqual([]);
  });

  it('案件を紐づけられる', async () => {
    const offerId = await createOffer(owner.id, blog1);

    const banner = await createBannerForUser(
      { userId: owner.id, blogId: blog1 },
      input({ affiliateOfferId: offerId }),
    );

    expect(banner.affiliateOfferId).toBe(offerId);
  });

  it('他人のブログには登録できない', async () => {
    await expect(
      createBannerForUser({ userId: owner.id, blogId: otherBlog }, input()),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.banner.count()).toBe(0);
  });

  it('CLOSED のブログには登録できない', async () => {
    await prisma.blog.update({
      where: { id: blog1 },
      data: { status: 'CLOSED' },
    });

    await expect(
      createBannerForUser({ userId: owner.id, blogId: blog1 }, input()),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * **C-6 で見つかった形の穴を、同じ場所に作らない。**
 * `affiliate_offers.id` は全ブログで一意なので、素通しすると他ブログの
 * 案件をバナーに紐づけられる。
 */
describe('紐づける案件の所有権', () => {
  it('他ブログの案件は紐づけられない', async () => {
    const offerId = await createOffer(owner.id, blog2);

    await expect(
      createBannerForUser(
        { userId: owner.id, blogId: blog1 },
        input({ affiliateOfferId: offerId }),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.banner.count()).toBe(0);
  });

  it('他人の案件は紐づけられない', async () => {
    const offerId = await createOffer(other.id, otherBlog);

    await expect(
      createBannerForUser(
        { userId: owner.id, blogId: blog1 },
        input({ affiliateOfferId: offerId }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('更新でも他ブログの案件に付け替えられない', async () => {
    const bannerId = (
      await createBannerForUser({ userId: owner.id, blogId: blog1 }, input())
    ).id;
    const offerId = await createOffer(owner.id, blog2);

    await expect(
      updateBannerForUser(
        { userId: owner.id, blogId: blog1, bannerId },
        { affiliateOfferId: offerId },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.banner.findUniqueOrThrow({
      where: { id: bannerId },
      select: { affiliateOfferId: true },
    });
    expect(row.affiliateOfferId).toBeNull();
  });

  it('null を渡せば紐付けを外せる', async () => {
    const offerId = await createOffer(owner.id, blog1);
    const bannerId = (
      await createBannerForUser(
        { userId: owner.id, blogId: blog1 },
        input({ affiliateOfferId: offerId }),
      )
    ).id;

    const updated = await updateBannerForUser(
      { userId: owner.id, blogId: blog1, bannerId },
      { affiliateOfferId: null },
    );

    expect(updated.affiliateOfferId).toBeNull();
  });
});

describe('ブログ別の分離', () => {
  let banner1: string;
  let banner2: string;

  beforeEach(async () => {
    banner1 = (
      await createBannerForUser(
        { userId: owner.id, blogId: blog1 },
        input({ name: 'ブログ1のバナー' }),
      )
    ).id;
    banner2 = (
      await createBannerForUser(
        { userId: owner.id, blogId: blog2 },
        input({ name: 'ブログ2のバナー', slot: 'SIDEBAR' }),
      )
    ).id;
  });

  it('一覧は指定したブログのものだけ', async () => {
    const list = await listBannersForUser({ userId: owner.id, blogId: blog1 });

    expect(list.map((banner) => banner.id)).toEqual([banner1]);
  });

  /** `banners.id` は全ブログで一意。条件に `blog_id` が要る */
  it('別ブログ経由では引けない', async () => {
    expect(
      await findBannerForUser({
        userId: owner.id,
        blogId: blog1,
        bannerId: banner2,
      }),
    ).toBeNull();
  });

  it('別ブログ経由では更新できない', async () => {
    await expect(
      updateBannerForUser(
        { userId: owner.id, blogId: blog1, bannerId: banner2 },
        { name: '書き換え' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.banner.findUniqueOrThrow({
      where: { id: banner2 },
      select: { name: true },
    });
    expect(row.name).toBe('ブログ2のバナー');
  });

  it('他人のバナーは404', async () => {
    const offerBanner = (
      await createBannerForUser(
        { userId: other.id, blogId: otherBlog },
        input(),
      )
    ).id;

    await expect(
      requireBannerForUser({
        userId: owner.id,
        blogId: blog1,
        bannerId: offerBanner,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('表示位置で絞れる', async () => {
    const list = await listBannersForUser(
      { userId: owner.id, blogId: blog2 },
      { slot: 'SIDEBAR' },
    );

    expect(list.map((banner) => banner.id)).toEqual([banner2]);
  });
});

describe('更新と終了', () => {
  let bannerId: string;

  beforeEach(async () => {
    bannerId = (
      await createBannerForUser(
        { userId: owner.id, blogId: blog1 },
        input({ startsAt: new Date('2026-08-01T00:00:00Z') }),
      )
    ).id;
  });

  it('渡した項目だけ変わる', async () => {
    const updated = await updateBannerForUser(
      { userId: owner.id, blogId: blog1, bannerId },
      { slot: 'BOTTOM' },
    );

    expect(updated.slot).toBe('BOTTOM');
    expect(updated.name).toBe('サンプルバナー');
  });

  it('対象カテゴリを差し替えられる', async () => {
    const updated = await updateBannerForUser(
      { userId: owner.id, blogId: blog1, bannerId },
      { targetCategories: ['ダイエット'] },
    );

    expect(updated.targetCategories).toEqual(['ダイエット']);
  });

  /** 片方だけ更新したときに、既存のもう片方と逆転するのを防ぐ */
  it('保存済みの開始日時より前の終了日時を拒否する', async () => {
    await expect(
      updateBannerForUser(
        { userId: owner.id, blogId: blog1, bannerId },
        { endsAt: new Date('2026-07-01T00:00:00Z') },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  /** 公開済み記事に埋まっており、クリックの集計も過去分を参照する */
  it('終了しても行は残る', async () => {
    const ended = await endBannerForUser({
      userId: owner.id,
      blogId: blog1,
      bannerId,
    });

    expect(ended.status).toBe('ENDED');
    expect(await prisma.banner.count()).toBe(1);
  });
});
