import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import {
  PLANNING_ERROR_CODES,
  designRevenueArticlesForUser,
  findLatestPlanForUser,
  listContentItemsForUser,
} from '@/modules/content-planning';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * STEP 3 収益記事の設計を**実PostgreSQL・実HTTPサーバーで**確かめる
 * （TASKS E-6、SPEC 9.2.4）。
 *
 * 確かめるのは3つ。
 *
 * 1. **記事数が「案件数×2＋1」になる**（完了条件）
 * 2. **AIが枠を増減させても保存されない**
 * 3. **実行のたびに新しい版が増える**（前の構成表を書き換えない）
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;

/** 受け取った枠に、その場でタイトルを付けて返す偽AI */
let respond: (slots: { slotId: string }[]) => {
  status: number;
  body: string;
};

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const content = (body as { messages: { content: string }[] }).messages[0]
        ?.content;
      const sent: unknown = JSON.parse(content ?? '{}');
      const slots = (sent as { slots?: { slotId: string }[] }).slots ?? [];

      const result = respond(slots);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function provider() {
  return createAiProvider({ env: { ANTHROPIC_API_KEY: 'sk-test' }, baseUrl });
}

let offerSequence = 0;

async function createOffer(targetBlogId = blogId): Promise<string> {
  offerSequence += 1;

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId: targetBlogId,
      name: `案件${offerSequence}`,
      aspName: 'テストASP',
      landingPageUrl: `https://example.com/lp/${offerSequence}`,
      affiliateUrl: `https://example.com/go/${offerSequence}`,
      // **リンクがある＝提携は承認済み**（Q-060）
      partnershipStatus: 'APPROVED',
      conversionType: 'FREE_SIGNUP',
      rewardYen: 10_000,
      facts: { features: ['機能A'] },
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  return offer.id;
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServer();
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;

  respond = (slots) => ({
    status: 200,
    body: aiText({
      items: slots.map((slot, index) => ({
        slotId: slot.slotId,
        title: `記事${index}`,
        primaryKeyword: `キーワード${index}`,
        searchIntent: `検索意図${index}`,
      })),
    }),
  });
});

describe('記事数（完了条件）', () => {
  it.each([
    [1, 3],
    [2, 5],
    [3, 7],
  ])('採用%s件 → %s本', async (offerCount, expected) => {
    const offerIds: string[] = [];
    for (let index = 0; index < offerCount; index += 1) {
      offerIds.push(await createOffer());
    }

    const result = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: offerIds },
      { provider: provider() },
    );

    expect(result.items).toHaveLength(expected);
    expect(result.expectedCount).toBe(expected);
  });

  it('案件ごとの2本は AFFILIATE、比較は COMPARISON', async () => {
    const offerId = await createOffer();

    const result = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    expect(result.items.map((item) => item.contentType)).toEqual([
      'AFFILIATE',
      'AFFILIATE',
      'COMPARISON',
    ]);
    expect(result.items[0]?.affiliateOfferId).toBe(offerId);
    expect(result.items[2]?.affiliateOfferId).toBeNull();
  });

  it('すべて収益目的で入る', async () => {
    const offerId = await createOffer();

    const result = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    expect(result.items.every((item) => item.objective === 'REVENUE')).toBe(
      true,
    );
    expect(result.items.map((item) => item.sequenceNo)).toEqual([1, 2, 3]);
  });
});

describe('AIが枠を守らない場合', () => {
  /** **確かめずに保存すると、AIが増やした構成表がそのまま通る** */
  it('枠を増やしたら保存しない', async () => {
    respond = (slots) => ({
      status: 200,
      body: aiText({
        items: [
          ...slots.map((slot, index) => ({
            slotId: slot.slotId,
            title: `記事${index}`,
            primaryKeyword: `キーワード${index}`,
            searchIntent: '意図',
          })),
          {
            slotId: 'ai-が-勝手に-足した-枠',
            title: '余分な記事',
            primaryKeyword: '余分',
            searchIntent: '意図',
          },
        ],
      }),
    });

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId, adoptedOfferIds: [await createOffer()] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep3Input });

    expect(await prisma.contentPlan.count()).toBe(0);
    expect(await prisma.contentItem.count()).toBe(0);
  });

  it('枠を減らしたら保存しない', async () => {
    respond = (slots) => ({
      status: 200,
      body: aiText({
        items: slots.slice(1).map((slot) => ({
          slotId: slot.slotId,
          title: '記事',
          primaryKeyword: `キーワード${slot.slotId}`,
          searchIntent: '意図',
        })),
      }),
    });

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId, adoptedOfferIds: [await createOffer()] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep3Input });

    expect(await prisma.contentItem.count()).toBe(0);
  });

  /** **半端な構成表を残さない**（1つのトランザクションで入れる） */
  it('キーワードが重複したら1件も保存しない', async () => {
    respond = (slots) => ({
      status: 200,
      body: aiText({
        items: slots.map((slot) => ({
          slotId: slot.slotId,
          title: '記事',
          primaryKeyword: '同じ語',
          searchIntent: '意図',
        })),
      }),
    });

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId, adoptedOfferIds: [await createOffer()] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep3Input });

    expect(await prisma.contentItem.count()).toBe(0);
  });

  /** **空のタイトルで構成表を作らない。** AIが呼べなければ失敗させる */
  it('AIが落ちたら保存しない', async () => {
    respond = () => ({ status: 500, body: '{}' });

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId, adoptedOfferIds: [await createOffer()] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: expect.any(Number) });

    expect(await prisma.contentPlan.count()).toBe(0);
  });
});

describe('構成表の版', () => {
  /**
   * **同じ版を書き換えない。** 書き換えると、既に投稿された記事が
   * どの構成表から生まれたのか分からなくなる。
   */
  it('実行のたびに版が増える', async () => {
    const offerId = await createOffer();

    const first = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );
    const second = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.planId).not.toBe(first.planId);
    expect(await prisma.contentItem.count()).toBe(6);
  });

  it('いちばん新しい版を引ける', async () => {
    const offerId = await createOffer();

    await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );
    const second = await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    const latest = await findLatestPlanForUser({
      userId,
      blogId,
      planType: 'INITIAL',
    });

    expect(latest).toEqual({ planId: second.planId, version: 2 });
  });
});

describe('他人の案件では作れない', () => {
  /** **渡されたIDをそのまま使わない**（C-6 と同じ形の穴を作らない） */
  it('他人の案件IDを渡しても作れない', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);
    const otherOffer = await createOffer(otherBlog.id);

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId, adoptedOfferIds: [otherOffer] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep3Input });

    expect(await prisma.contentItem.count()).toBe(0);
  });

  it('他人のブログでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      designRevenueArticlesForUser(
        { userId, blogId: otherBlog.id, adoptedOfferIds: [] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('一覧に他人の記事が混ざらない', async () => {
    const offerId = await createOffer();
    await designRevenueArticlesForUser(
      { userId, blogId, adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    const items = await listContentItemsForUser({ userId, blogId });

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.blogId === blogId)).toBe(true);
  });
});
