import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createOfferForUser, generateRedirectCode } from '@/modules/affiliate';
import { recordLinkEvents } from '@/modules/analytics';
import { createBannerForUser } from '@/modules/banners';
import {
  findBlogIdByLinkEventToken,
  issueLinkEventTokenForUser,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * クリック受信API（TASKS D-12、Q-001 の再決定）を**実PostgreSQLで**確かめる。
 *
 * 完了条件のうち、ここで見るのは
 * **「受信APIはブログ単位のトークンで認証し、他ブログのイベントを投入できない」**と
 * **再送で二重に数えないこと**（D-12-schema-2）。
 */

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blogId: string;
let otherBlogId: string;

const NOW = new Date('2026-08-12T03:00:00.000Z');

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

  blogId = (await createBlog(prisma, owner.id)).id;
  otherBlogId = (await createBlog(prisma, other.id)).id;
});

/**
 * **トークンがブログを決める。** ブログIDを本文で受けてから照合する形に
 * すると、照合を1か所忘れただけで他ブログのイベントを名乗れる。
 */
describe('トークン', () => {
  it('発行したトークンでそのブログを引ける', async () => {
    const issued = await issueLinkEventTokenForUser({
      userId: owner.id,
      blogId,
      now: NOW,
    });

    expect(await findBlogIdByLinkEventToken(issued.token)).toBe(blogId);
  });

  /** **原文は保存しない。** DBを読めた相手が他ブログのイベントを投入できない */
  it('DBには原文が入らない', async () => {
    const issued = await issueLinkEventTokenForUser({
      userId: owner.id,
      blogId,
      now: NOW,
    });

    const row = await prisma.blog.findUniqueOrThrow({
      where: { id: blogId },
      select: { linkEventTokenHash: true, linkEventTokenIssuedAt: true },
    });

    expect(row.linkEventTokenHash).not.toBe(issued.token);
    expect(row.linkEventTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.linkEventTokenIssuedAt).toEqual(NOW);
  });

  it('知らないトークンでは引けない', async () => {
    await issueLinkEventTokenForUser({ userId: owner.id, blogId, now: NOW });

    expect(await findBlogIdByLinkEventToken('でたらめ')).toBeNull();
    expect(await findBlogIdByLinkEventToken('')).toBeNull();
  });

  /** **作り直すと古いものはその場で効かなくなる**（漏れたときの差し替え） */
  it('作り直すと古いトークンは効かない', async () => {
    const first = await issueLinkEventTokenForUser({
      userId: owner.id,
      blogId,
      now: NOW,
    });
    const second = await issueLinkEventTokenForUser({
      userId: owner.id,
      blogId,
      now: NOW,
    });

    expect(await findBlogIdByLinkEventToken(first.token)).toBeNull();
    expect(await findBlogIdByLinkEventToken(second.token)).toBe(blogId);
  });

  it('他人のブログには発行できない', async () => {
    await expect(
      issueLinkEventTokenForUser({ userId: owner.id, blogId: otherBlogId }),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.blog.findUniqueOrThrow({
      where: { id: otherBlogId },
      select: { linkEventTokenHash: true },
    });

    // **相手の行が変わっていないこと**まで見る
    expect(row.linkEventTokenHash).toBeNull();
  });

  /**
   * **閉じたブログのイベントは受けない。** 閉じたあとに届くものは、
   * スニペットの外し忘れかトークンの持ち出し
   */
  it('閉じたブログのトークンは効かない', async () => {
    const issued = await issueLinkEventTokenForUser({
      userId: owner.id,
      blogId,
      now: NOW,
    });

    await prisma.blog.update({
      where: { id: blogId },
      data: { status: 'CLOSED' },
    });

    expect(await findBlogIdByLinkEventToken(issued.token)).toBeNull();
  });
});

/** クリックの保存。**再送で二重に数えない**（D-12-schema-2） */
describe('クリックの保存', () => {
  async function createLinkId(): Promise<string> {
    const offer = await createOfferForUser(
      { userId: owner.id, blogId },
      {
        name: '案件',
        aspName: 'ASP',
        landingPageUrl: 'https://example.com/lp',
        affiliateUrl: 'https://asp.example/click?a=x',
        conversionType: 'FREE_SIGNUP',
        facts: {},
      },
    );

    // **記事に紐づかないリンクを直接作る。** ここで見たいのは受信の側で、
    // リンクの組み立て（D-9）は `affiliate-redirect.test.ts` の担当
    const link = await prisma.affiliateLink.create({
      data: {
        code: generateRedirectCode(),
        affiliateOfferId: offer.id,
        blogId,
        destinationUrl: 'https://asp.example/click?a=x',
      },
      select: { id: true },
    });

    return link.id;
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      eventId: 'evt-1',
      code: 'unused',
      clickedAt: NOW,
      referrerHost: 'example.com',
      userAgentHash: 'a'.repeat(64),
      affiliateLinkId: null,
      bannerId: null,
      ...overrides,
    } as Parameters<typeof recordLinkEvents>[0][number];
  }

  it('案件のクリックを保存する', async () => {
    const affiliateLinkId = await createLinkId();

    const result = await recordLinkEvents([input({ affiliateLinkId })]);

    expect(result).toEqual({ inserted: 1, duplicated: 0 });

    const row = await prisma.linkClick.findFirstOrThrow({
      where: { eventId: 'evt-1' },
    });
    expect(row.affiliateLinkId).toBe(affiliateLinkId);
    expect(row.bannerId).toBeNull();
    expect(row.referrerHost).toBe('example.com');
  });

  it('バナーのクリックを保存する', async () => {
    const banner = await createBannerForUser(
      { userId: owner.id, blogId },
      {
        name: 'バナー',
        imageUrl: 'https://example.com/b.png',
        destinationUrl: 'https://example.com/lp',
        slot: 'TOP',
        targetCategories: [],
      },
    );

    const result = await recordLinkEvents([input({ bannerId: banner.id })]);

    expect(result.inserted).toBe(1);

    const row = await prisma.linkClick.findFirstOrThrow({
      where: { eventId: 'evt-1' },
    });
    expect(row.bannerId).toBe(banner.id);
    expect(row.affiliateLinkId).toBeNull();
  });

  /**
   * **同じ電文が2回届いても行が増えない。** 送信元は応答が失われたときに
   * 再送するので、回数を送信元に任せられない
   */
  it('同じ識別子は二度目が入らない', async () => {
    const affiliateLinkId = await createLinkId();
    const events = [input({ affiliateLinkId })];

    expect(await recordLinkEvents(events)).toEqual({
      inserted: 1,
      duplicated: 0,
    });
    expect(await recordLinkEvents(events)).toEqual({
      inserted: 0,
      duplicated: 1,
    });

    expect(await prisma.linkClick.count()).toBe(1);
  });

  it('AI検索経由かを受信側で判別する', async () => {
    const affiliateLinkId = await createLinkId();

    await recordLinkEvents([
      input({ affiliateLinkId, referrerHost: 'chatgpt.com' }),
    ]);

    const row = await prisma.linkClick.findFirstOrThrow({
      where: { eventId: 'evt-1' },
    });

    expect(row.isAiReferral).toBe(true);
  });

  it('何も渡さなければ何も起きない', async () => {
    expect(await recordLinkEvents([])).toEqual({ inserted: 0, duplicated: 0 });
    expect(await prisma.linkClick.count()).toBe(0);
  });
});
