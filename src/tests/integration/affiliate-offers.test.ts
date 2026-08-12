import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  buildAffiliateLink,
  createOfferForUser,
  endOfferForUser,
  findOfferForUser,
  listOffersForUser,
  readLinkableOfferForUser,
  requireOfferForUser,
  updateOfferForUser,
  type CreateOfferInput,
} from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 案件が**ブログ別に分離される**ことを実PostgreSQLで確かめる（TASKS D-1）。
 *
 * 完了条件は「**ブログ別に分離。他ブログの案件が見えない**」。
 * `affiliate_offers.id` は全ブログで一意なので、**IDだけで引くと他ブログの
 * 案件が取れる**。条件に `blog_id` が入っているかは、fake では確かめられない。
 */

const CONTENT_ITEM_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;

function input(overrides: Partial<CreateOfferInput> = {}): CreateOfferInput {
  return {
    name: 'サンプル案件',
    aspName: 'サンプルASP',
    landingPageUrl: 'https://lp.example.com/offer',
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    conversionType: 'FREE_SIGNUP',
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

describe('登録', () => {
  it('案件を登録できる', async () => {
    const offer = await createOfferForUser(
      { userId: owner.id, blogId: blog1 },
      input({ rewardYen: 3000, advertiserName: '広告主' }),
    );

    expect(offer).toMatchObject({
      blogId: blog1,
      name: 'サンプル案件',
      rewardYen: 3000,
      advertiserName: '広告主',
      status: 'DRAFT',
    });
  });

  /**
   * **既定は `DIRECT`（安全側・Q-001）。** 規約を確認できたASPだけ
   * ADMIN が `REDIRECT` へ上げる。
   */
  it('リンク方式の既定は DIRECT', async () => {
    const offer = await createOfferForUser(
      { userId: owner.id, blogId: blog1 },
      input(),
    );

    expect(offer.linkMode).toBe('DIRECT');
  });

  /**
   * **モニターに規約の判断をさせない**（Q-001・Q-014）。
   * 入力に混ぜても保存されない。
   */
  it('link_mode と sub_id_param は入力から設定できない', async () => {
    const offer = await createOfferForUser(
      { userId: owner.id, blogId: blog1 },
      {
        ...input(),
        linkMode: 'REDIRECT',
        subIdParam: 'sub',
      } as CreateOfferInput,
    );

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offer.id },
      select: { linkMode: true, subIdParam: true },
    });

    expect(row.linkMode).toBe('DIRECT');
    expect(row.subIdParam).toBeNull();
  });

  it('他人のブログには登録できない', async () => {
    await expect(
      createOfferForUser({ userId: owner.id, blogId: otherBlog }, input()),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.affiliateOffer.count()).toBe(0);
  });
});

describe('ブログ別の分離（完了条件）', () => {
  let offer1: string;
  let offer2: string;
  let offerOther: string;

  beforeEach(async () => {
    offer1 = (
      await createOfferForUser(
        { userId: owner.id, blogId: blog1 },
        input({ name: 'ブログ1の案件' }),
      )
    ).id;
    offer2 = (
      await createOfferForUser(
        { userId: owner.id, blogId: blog2 },
        input({ name: 'ブログ2の案件' }),
      )
    ).id;
    offerOther = (
      await createOfferForUser(
        { userId: other.id, blogId: otherBlog },
        input({ name: '他人の案件' }),
      )
    ).id;
  });

  it('一覧は指定したブログのものだけ', async () => {
    const list = await listOffersForUser({ userId: owner.id, blogId: blog1 });

    expect(list.map((offer) => offer.id)).toEqual([offer1]);
  });

  /**
   * **`affiliate_offers.id` は全ブログで一意。** 条件に `blog_id` が
   * 入っていないと、IDを知るだけで他ブログの案件が取れる。
   */
  it('別ブログ経由では自分の案件も引けない', async () => {
    expect(
      await findOfferForUser({
        userId: owner.id,
        blogId: blog2,
        offerId: offer1,
      }),
    ).toBeNull();
  });

  it('他人の案件は 404', async () => {
    await expect(
      requireOfferForUser({
        userId: owner.id,
        blogId: blog1,
        offerId: offerOther,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('別ブログ経由では更新できない', async () => {
    await expect(
      updateOfferForUser(
        { userId: owner.id, blogId: blog2, offerId: offer1 },
        { name: '書き換え' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offer1 },
      select: { name: true },
    });
    expect(row.name).toBe('ブログ1の案件');
  });

  it('他人の案件は終了できない', async () => {
    await expect(
      endOfferForUser({
        userId: owner.id,
        blogId: blog1,
        offerId: offerOther,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.affiliateOffer.findUniqueOrThrow({
      where: { id: offerOther },
      select: { status: true },
    });
    expect(row.status).toBe('DRAFT');
  });

  it('リンク用の取得も別ブログでは 404', async () => {
    await expect(
      readLinkableOfferForUser({
        userId: owner.id,
        blogId: blog2,
        offerId: offer1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  // 一覧の絞り込みでも他ブログが混ざらない
  it('状態で絞っても他ブログは出ない', async () => {
    await updateOfferForUser(
      { userId: owner.id, blogId: blog2, offerId: offer2 },
      { status: 'ACTIVE' },
    );

    const list = await listOffersForUser(
      { userId: owner.id, blogId: blog1 },
      { status: 'ACTIVE' },
    );

    expect(list).toHaveLength(0);
  });
});

describe('更新と終了', () => {
  let offerId: string;

  beforeEach(async () => {
    offerId = (
      await createOfferForUser(
        { userId: owner.id, blogId: blog1 },
        input({ startsAt: new Date('2026-08-01T00:00:00Z') }),
      )
    ).id;
  });

  it('渡した項目だけ変わる', async () => {
    const updated = await updateOfferForUser(
      { userId: owner.id, blogId: blog1, offerId },
      { status: 'ACTIVE' },
    );

    expect(updated.status).toBe('ACTIVE');
    expect(updated.name).toBe('サンプル案件');
  });

  /**
   * **片方だけ更新したときに、既存のもう片方と逆転するのを防ぐ。**
   * 入力だけを見ていると通ってしまう。
   */
  it('保存済みの開始日より前の終了日を拒否する', async () => {
    await expect(
      updateOfferForUser(
        { userId: owner.id, blogId: blog1, offerId },
        { endsAt: new Date('2026-07-01T00:00:00Z') },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('開始日より後の終了日は通す', async () => {
    const updated = await updateOfferForUser(
      { userId: owner.id, blogId: blog1, offerId },
      { endsAt: new Date('2026-09-01T00:00:00Z') },
    );

    expect(updated.endsAt).not.toBeNull();
  });

  /**
   * **物理削除しない。** 記事に埋め込んだリンクが残っており、
   * 成果の紐付け（サブID）も過去分を参照する。
   */
  it('終了しても行は残る', async () => {
    const ended = await endOfferForUser({
      userId: owner.id,
      blogId: blog1,
      offerId,
    });

    expect(ended.status).toBe('ENDED');
    expect(await prisma.affiliateOffer.count()).toBe(1);
  });
});

describe('リンクの組み立て（ADMIN が設定した値で切り替わる）', () => {
  let offerId: string;

  beforeEach(async () => {
    offerId = (
      await createOfferForUser({ userId: owner.id, blogId: blog1 }, input())
    ).id;
  });

  it('既定では DIRECT のまま、サブIDも付かない', async () => {
    const offer = await readLinkableOfferForUser({
      userId: owner.id,
      blogId: blog1,
      offerId,
    });

    const link = buildAffiliateLink({
      offer,
      slotNumber: 1,
      contentItemId: CONTENT_ITEM_ID,
      baseUrl: 'https://app.example.com',
    });

    expect(link.linkMode).toBe('DIRECT');
    expect(link.subId).toBeNull();
    expect(link.href).toBe('https://asp.example/click?a=xxxx');
  });

  /**
   * ADMIN が SQL で設定する運用（SPEC 10.3 と同じ扱い）。
   * **設定を入れれば、記事側のコードを変えずに切り替わる。**
   */
  it('ADMIN が設定すれば REDIRECT とサブIDが効く', async () => {
    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: { linkMode: 'REDIRECT', subIdParam: 'sub' },
    });

    const offer = await readLinkableOfferForUser({
      userId: owner.id,
      blogId: blog1,
      offerId,
    });

    const link = buildAffiliateLink({
      offer,
      slotNumber: 1,
      contentItemId: CONTENT_ITEM_ID,
      redirectCode: 'abc123',
      baseUrl: 'https://app.example.com',
    });

    expect(link.href).toBe('https://app.example.com/go/abc123');
    expect(link.destinationUrl).toBe(
      `https://asp.example/click?a=xxxx&sub=1-${CONTENT_ITEM_ID}`,
    );
  });

  // 外向けの表現に混ぜない（モニターの画面に出す理由が無い）
  it('sub_id_param は AppAffiliateOffer に含まれない', async () => {
    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: { subIdParam: 'sub' },
    });

    const offer = await requireOfferForUser({
      userId: owner.id,
      blogId: blog1,
      offerId,
    });

    expect(offer).not.toHaveProperty('subIdParam');
  });
});

describe('閉じたブログ', () => {
  it('CLOSED のブログには案件を足せない', async () => {
    await prisma.blog.update({
      where: { id: blog1 },
      data: { status: 'CLOSED' },
    });

    await expect(
      createOfferForUser({ userId: owner.id, blogId: blog1 }, input()),
    ).rejects.toMatchObject({ status: 404 });
  });
});
