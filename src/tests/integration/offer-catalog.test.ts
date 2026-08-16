import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  createCatalogItemForAdmin,
  createOfferForUser,
  listCatalogForAdmin,
  listOffersNeedingFactCheckForUser,
  listSelectableCatalog,
  readCatalogItem,
  updateCatalogItemForAdmin,
  type CatalogItemInput,
} from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 案件カタログ（Q-055、段8）を**実PostgreSQLで**確かめる。
 *
 * 見るのは3つ。
 *
 * 1. **`facts_updated_at` は `facts` を変えたときだけ動く**（D-13）。
 *    状態を変えただけで「確かめ直した」ことになると、
 *    **古い価格が「今日確かめた」として記事に出る**
 * 2. **モニターに出るのは確かめ終えたものだけ**
 * 3. **元が新しくなったブログの案件を挙げられる** —
 *    同じ商品が2ブログにあると、片方だけ古いまま「確かめ済み」で通る
 */

let prisma: PrismaClient;
let adminId: string;
let userId: string;
let blogId: string;

function input(overrides: Partial<CatalogItemInput> = {}): CatalogItemInput {
  return {
    name: '格安SIM A',
    aspName: 'テストASP',
    landingPageUrl: 'https://lp.example.com/a',
    conversionType: 'FREE_SIGNUP',
    facts: ['月額1,480円', '初期費用なし'],
    ...overrides,
  };
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

  const admin = await createUser(prisma, { displayName: '管理者' });
  await prisma.user.update({
    where: { id: admin.id },
    data: { role: 'ADMIN' },
  });
  adminId = admin.id;

  const monitor = await createUser(prisma, { displayName: 'モニター' });
  userId = monitor.id;

  const blog = await createBlog(prisma, monitor.id);
  blogId = blog.id;
});

describe('登録する', () => {
  it('読み直せる', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);

    expect(created.name).toBe('格安SIM A');
    expect(created.facts).toEqual(['月額1,480円', '初期費用なし']);

    const read = await readCatalogItem(created.id);

    expect(read?.aspName).toBe('テストASP');
  });

  /** **事実が入って初めて「確かめた」**（D-13） */
  it('事実を入れると facts_updated_at が入る', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);

    expect(created.factsUpdatedAt).not.toBeNull();
  });

  it('事実が空なら facts_updated_at は入らない', async () => {
    const created = await createCatalogItemForAdmin(
      input({ facts: [] }),
      adminId,
    );

    expect(created.factsUpdatedAt).toBeNull();
  });

  it('空行と重複を落とす', async () => {
    const created = await createCatalogItemForAdmin(
      input({ facts: ['月額1,480円', '  ', '月額1,480円', ' 初期費用なし '] }),
      adminId,
    );

    expect(created.facts).toEqual(['月額1,480円', '初期費用なし']);
  });

  /** **同じものを二度登録しない** */
  it('ASPと紹介先が同じなら断る', async () => {
    await createCatalogItemForAdmin(input(), adminId);

    await expect(
      createCatalogItemForAdmin(input({ name: '別の名前' }), adminId),
    ).rejects.toThrow(/すでに登録/);
  });

  it('ASPが違えば同じ紹介先でも登録できる', async () => {
    await createCatalogItemForAdmin(input(), adminId);
    await createCatalogItemForAdmin(input({ aspName: 'べつのASP' }), adminId);

    expect(await prisma.offerCatalogItem.count()).toBe(2);
  });
});

/**
 * **状態を変えただけで「確かめ直した」ことにしない**（D-13）。
 * すると、古い価格が「今日確かめた」として記事に出る。
 */
describe('直したとき、確かめた時刻がいつ動くか', () => {
  it('事実を変えたら動く', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);
    const before = created.factsUpdatedAt;

    const updated = await updateCatalogItemForAdmin(
      created.id,
      input({ facts: ['月額980円', '初期費用なし'] }),
      adminId,
    );

    expect(updated.factsUpdatedAt).not.toBeNull();
    expect(updated.factsUpdatedAt?.getTime() ?? 0).toBeGreaterThan(
      before?.getTime() ?? 0,
    );
  });

  it('状態だけ変えても動かない', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);

    const updated = await updateCatalogItemForAdmin(
      created.id,
      input({ status: 'ACTIVE' }),
      adminId,
    );

    expect(updated.status).toBe('ACTIVE');
    expect(updated.factsUpdatedAt?.toISOString()).toBe(
      created.factsUpdatedAt?.toISOString(),
    );
  });

  it('名前だけ変えても動かない', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);

    const updated = await updateCatalogItemForAdmin(
      created.id,
      input({ name: '格安SIM A（改）' }),
      adminId,
    );

    expect(updated.factsUpdatedAt?.toISOString()).toBe(
      created.factsUpdatedAt?.toISOString(),
    );
  });

  it('並びが同じなら動かない', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);

    const updated = await updateCatalogItemForAdmin(
      created.id,
      input({ facts: [' 月額1,480円 ', '初期費用なし'] }),
      adminId,
    );

    expect(updated.factsUpdatedAt?.toISOString()).toBe(
      created.factsUpdatedAt?.toISOString(),
    );
  });
});

/** **DBでも守らせる**（アプリ側の書き方に依存させない） */
describe('DBが決まりを守らせている', () => {
  it('確かめた時刻だけ入れて事実が空の行を作れない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into offer_catalog_items
           (id, name, asp_name, landing_page_url, conversion_type, facts, facts_updated_at, updated_at)
         values (gen_random_uuid(), 'x', 'a', 'https://e.test/1', 'FREE_SIGNUP', '[]'::jsonb, now(), now())`,
      ),
    ).rejects.toThrow();
  });

  /** **モニターに出すものは事実を確かめてある** */
  it('確かめていないものを ACTIVE にできない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into offer_catalog_items
           (id, name, asp_name, landing_page_url, conversion_type, facts, status, updated_at)
         values (gen_random_uuid(), 'x', 'a', 'https://e.test/2', 'FREE_SIGNUP', '[]'::jsonb, 'ACTIVE', now())`,
      ),
    ).rejects.toThrow();
  });

  it('報酬額に負の数を入れられない', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `insert into offer_catalog_items
           (id, name, asp_name, landing_page_url, conversion_type, reward_yen, updated_at)
         values (gen_random_uuid(), 'x', 'a', 'https://e.test/3', 'FREE_SIGNUP', -1, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('モニターに出す一覧', () => {
  /** **下書きは調べている途中。** 中途半端なものを選ばせない */
  it('下書きは出さない', async () => {
    await createCatalogItemForAdmin(input(), adminId);

    expect(await listSelectableCatalog()).toEqual([]);
    expect(await listCatalogForAdmin()).toHaveLength(1);
  });

  it('選べるものだけ出す', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);
    await updateCatalogItemForAdmin(
      created.id,
      input({ status: 'ACTIVE' }),
      adminId,
    );

    expect(await listSelectableCatalog()).toHaveLength(1);
  });

  /** **選べてしまったあとで止めない**（SPEC 9.2.3 の足切り） */
  it('掲載禁止のものは出さない', async () => {
    const created = await createCatalogItemForAdmin(input(), adminId);
    await updateCatalogItemForAdmin(
      created.id,
      input({ status: 'ACTIVE', blogPostingProhibited: true }),
      adminId,
    );

    expect(await listSelectableCatalog()).toEqual([]);
  });
});

/**
 * **同じ商品が2ブログにあると、片方だけ古い価格が残る。**
 * しかも `facts_updated_at` は入っているので「確かめ済み」として通り、
 * **古い価格がそのまま公開される**（SPEC 9.6）。
 */
describe('元が新しくなった案件を挙げる', () => {
  async function offerFromCatalog(catalogItemId: string): Promise<string> {
    const offer = await createOfferForUser(
      { userId, blogId },
      {
        name: '格安SIM A',
        aspName: 'テストASP',
        landingPageUrl: 'https://lp.example.com/a',
        affiliateUrl: 'https://asp.example.com/click?a=1',
        conversionType: 'FREE_SIGNUP',
        facts: ['月額1,480円'],
      },
    );

    await prisma.affiliateOffer.update({
      where: { id: offer.id },
      data: { catalogItemId },
    });

    return offer.id;
  }

  it('元のほうが新しければ挙げる', async () => {
    const item = await createCatalogItemForAdmin(input(), adminId);
    const offerId = await offerFromCatalog(item.id);

    // 元だけを直す
    await updateCatalogItemForAdmin(
      item.id,
      input({ facts: ['月額980円'] }),
      adminId,
    );

    const alerts = await listOffersNeedingFactCheckForUser({ userId, blogId });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.offerId).toBe(offerId);
  });

  it('元が古いままなら挙げない', async () => {
    const item = await createCatalogItemForAdmin(input(), adminId);
    await offerFromCatalog(item.id);

    expect(await listOffersNeedingFactCheckForUser({ userId, blogId })).toEqual(
      [],
    );
  });

  /** **一度も確かめていないのは、元より古いのと同じ** */
  it('ブログ側が一度も確かめていなければ挙げる', async () => {
    const item = await createCatalogItemForAdmin(input(), adminId);
    const offerId = await offerFromCatalog(item.id);

    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: { factsUpdatedAt: null },
    });

    expect(
      await listOffersNeedingFactCheckForUser({ userId, blogId }),
    ).toHaveLength(1);
  });

  /** **手で入れた案件は元を持たない** */
  it('元に紐づいていない案件は挙げない', async () => {
    await createOfferForUser(
      { userId, blogId },
      {
        name: '手で入れた案件',
        aspName: 'テストASP',
        landingPageUrl: 'https://lp.example.com/b',
        affiliateUrl: 'https://asp.example.com/click?b=1',
        conversionType: 'FREE_SIGNUP',
        facts: ['月額1,000円'],
      },
    );

    expect(await listOffersNeedingFactCheckForUser({ userId, blogId })).toEqual(
      [],
    );
  });

  /** **書き換えない。** 知らせるだけ（D-13・Q-022） */
  it('挙げても、ブログ側の事実は変わらない', async () => {
    const item = await createCatalogItemForAdmin(input(), adminId);
    const offerId = await offerFromCatalog(item.id);

    await updateCatalogItemForAdmin(
      item.id,
      input({ facts: ['月額980円'] }),
      adminId,
    );
    await listOffersNeedingFactCheckForUser({ userId, blogId });

    const offer = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: { facts: true },
    });

    expect(offer.facts).toEqual(['月額1,480円']);
  });
});
