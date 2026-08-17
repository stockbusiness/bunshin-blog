import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import {
  INBOUND_LINK_MIN,
  PLANNING_ERROR_CODES,
  designRevenueArticlesForUser,
  designTrafficArticlesForUser,
  listContentItemsForUser,
} from '@/modules/content-planning';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * STEP 4 集客記事とリンク設計を**実PostgreSQL・実HTTPサーバーで**確かめる
 * （TASKS E-7、SPEC 9.2.5）。
 *
 * 完了条件は「**リンク先に `AFFILIATE` 以外を指定できない**」。
 * 手作業での検証では30本中9本でこの誤りが起きた（CONTENT_PLANNING 5.5）。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;

/** プロンプトのキーごとに応答を差し替える */
let handlers: Record<string, (input: Record<string, unknown>) => unknown>;

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

/** 送られてきた入力の形から、どの呼び出しかを見分ける */
function classify(input: Record<string, unknown>): string {
  if ('slots' in input) return 'revenueTitles';
  if ('revenueItems' in input) return 'searchIntents';
  if ('conflicts' in input) return 'keywordConflict';
  if ('intents' in input) return 'keywords';

  return 'unknown';
}

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const raw = (body as { messages: { content: string }[] }).messages[0]
        ?.content;
      const input = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      const handler = handlers[classify(input)];

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(aiText(handler === undefined ? {} : handler(input)));
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

let sequence = 0;

async function createOffer(): Promise<string> {
  sequence += 1;

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: `案件${sequence}`,
      aspName: 'テストASP',
      landingPageUrl: `https://example.com/lp/${sequence}`,
      affiliateUrl: `https://example.com/go/${sequence}`,
      // **リンクがある＝提携は承認済み**（Q-060）
      partnershipStatus: 'APPROVED',
      conversionType: 'FREE_SIGNUP',
      rewardYen: 10_000,
      facts: {},
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  return offer.id;
}

/** STEP 3 まで済ませ、構成表のIDを返す */
async function buildPlan(): Promise<string> {
  const offerId = await createOffer();
  const result = await designRevenueArticlesForUser(
    { userId, blogId, adoptedOfferIds: [offerId] },
    { provider: provider() },
  );

  return result.planId;
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

  handlers = {
    revenueTitles: (input) => ({
      items: (input['slots'] as { slotId: string }[]).map((slot, index) => ({
        slotId: slot.slotId,
        title: `収益記事${index}`,
        primaryKeyword: `収益キーワード${index}`,
        searchIntent: '意図',
      })),
    }),
    // 収益記事ごとに3件の検索意図
    searchIntents: (input) => ({
      intents: (input['revenueItems'] as { itemId: string }[]).flatMap((item) =>
        Array.from({ length: INBOUND_LINK_MIN }, (_, index) => ({
          revenueItemId: item.itemId,
          intent: `意図${index}`,
          readerState: '状態',
        })),
      ),
    }),
    keywords: (input) => ({
      items: (input['intents'] as { intentId: string }[]).map(
        (intent, index) => ({
          intentId: intent.intentId,
          title: `集客記事${index}`,
          primaryKeyword: `集客キーワード${index}`,
          contentType: 'INFORMATIONAL',
        }),
      ),
    }),
    keywordConflict: (input) => ({
      items: (input['conflicts'] as { intentId: string }[]).map(
        (conflict, index) => ({
          intentId: conflict.intentId,
          title: `差し替え${index}`,
          primaryKeyword: `差し替えキーワード${index}`,
        }),
      ),
    }),
  };
});

describe('リンク先は AFFILIATE だけ（完了条件）', () => {
  it('集客記事のリンク先はすべて AFFILIATE', async () => {
    const planId = await buildPlan();

    await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    const items = await listContentItemsForUser({ userId, blogId });
    const byId = new Map(items.map((item) => [item.id, item]));

    const rows = await prisma.contentItem.findMany({
      where: { blogId },
      select: { id: true, outboundLinkItemIds: true },
    });

    for (const row of rows) {
      for (const target of row.outboundLinkItemIds) {
        expect(byId.get(target)?.contentType).toBe('AFFILIATE');
      }
    }
  });

  /**
   * **比較記事はリンク先にならない。** 収益記事ではあるが種別が
   * `COMPARISON` で、規則をそのまま適用する。
   */
  it('比較記事へはリンクしない', async () => {
    const planId = await buildPlan();

    await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    const comparison = (await listContentItemsForUser({ userId, blogId })).find(
      (item) => item.contentType === 'COMPARISON',
    );

    const rows = await prisma.contentItem.findMany({
      where: { blogId },
      select: { outboundLinkItemIds: true },
    });

    expect(comparison).toBeDefined();
    for (const row of rows) {
      expect(row.outboundLinkItemIds).not.toContain(comparison?.id);
    }
  });

  /** **AIが作った収益記事IDをそのまま使わない** */
  it('知らない収益記事IDを指しても保存しない', async () => {
    const planId = await buildPlan();

    handlers['searchIntents'] = () => ({
      intents: [
        {
          revenueItemId: '00000000-0000-4000-8000-000000000000',
          intent: '意図',
          readerState: '状態',
        },
      ],
    });

    await expect(
      designTrafficArticlesForUser(
        { userId, blogId, contentPlanId: planId, genreName: '節約' },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep4Input });

    const trafficCount = await prisma.contentItem.count({
      where: { blogId, objective: 'TRAFFIC' },
    });
    expect(trafficCount).toBe(0);
  });

  /** 収益記事へリンクさせようとしても、種別で弾かれる */
  it('集客記事どうしのリンクは作られない', async () => {
    const planId = await buildPlan();

    await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    const traffic = (await listContentItemsForUser({ userId, blogId })).filter(
      (item) => item.objective === 'TRAFFIC',
    );
    const trafficIds = new Set(traffic.map((item) => item.id));

    const rows = await prisma.contentItem.findMany({
      where: { blogId },
      select: { outboundLinkItemIds: true },
    });

    for (const row of rows) {
      for (const target of row.outboundLinkItemIds) {
        expect(trafficIds.has(target)).toBe(false);
      }
    }
  });
});

describe('リンクの割り当て', () => {
  it('収益記事の被リンクが埋まる', async () => {
    const planId = await buildPlan();

    const result = await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    // 収益記事は AFFILIATE 2本。1本あたり3件の意図 → 6本の集客記事
    expect(result.items).toHaveLength(6);
    expect(Object.values(result.inboundCounts)).toEqual([
      INBOUND_LINK_MIN,
      INBOUND_LINK_MIN,
    ]);
    expect(result.underLinked).toEqual([]);
  });

  /** **収益記事の `outbound` は空**（DATA_MODEL 4章の2） */
  it('収益記事はリンクを持たない', async () => {
    const planId = await buildPlan();

    await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    const rows = await prisma.contentItem.findMany({
      where: { blogId, contentType: 'AFFILIATE' },
      select: { outboundLinkItemIds: true, inboundLinkItemIds: true },
    });

    for (const row of rows) {
      expect(row.outboundLinkItemIds).toEqual([]);
      expect(row.inboundLinkItemIds).toHaveLength(INBOUND_LINK_MIN);
    }
  });

  /** 3本に満たない収益記事を見えるようにする（判定は E-8） */
  it('被リンクが足りない収益記事を返す', async () => {
    const planId = await buildPlan();

    handlers['searchIntents'] = (input) => ({
      intents: (input['revenueItems'] as { itemId: string }[]).map((item) => ({
        revenueItemId: item.itemId,
        intent: '意図',
        readerState: '状態',
      })),
    });

    const result = await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    expect(result.underLinked).toHaveLength(2);
  });
});

describe('キーワードの重複', () => {
  /** **`existingKeywords` を渡しても重複は出る** */
  it('既存と重なったら差し替え案を当てる', async () => {
    const planId = await buildPlan();

    handlers['keywords'] = (input) => ({
      items: (input['intents'] as { intentId: string }[]).map((intent) => ({
        intentId: intent.intentId,
        title: '重複記事',
        // 収益記事と同じキーワードを返す
        primaryKeyword: '収益キーワード0',
        contentType: 'INFORMATIONAL',
      })),
    });

    const result = await designTrafficArticlesForUser(
      { userId, blogId, contentPlanId: planId, genreName: '節約' },
      { provider: provider() },
    );

    const keywords = result.items.map((item) => item.primaryKeyword);

    expect(keywords).not.toContain('収益キーワード0');
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  /** 差し替えても直らなければ、その候補は保存しない */
  it('直らない候補は落とす', async () => {
    const planId = await buildPlan();

    handlers['keywords'] = (input) => ({
      items: (input['intents'] as { intentId: string }[]).map((intent) => ({
        intentId: intent.intentId,
        title: '重複記事',
        primaryKeyword: '収益キーワード0',
        contentType: 'INFORMATIONAL',
      })),
    });
    handlers['keywordConflict'] = (input) => ({
      items: (input['conflicts'] as { intentId: string }[]).map((conflict) => ({
        intentId: conflict.intentId,
        title: 'まだ重複',
        primaryKeyword: '収益キーワード0',
      })),
    });

    await expect(
      designTrafficArticlesForUser(
        { userId, blogId, contentPlanId: planId, genreName: '節約' },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep4Input });
  });
});

describe('他人の構成表では作れない', () => {
  it('他人のブログでは 404', async () => {
    const planId = await buildPlan();
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      designTrafficArticlesForUser(
        {
          userId,
          blogId: otherBlog.id,
          contentPlanId: planId,
          genreName: '節約',
        },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  /** **`contentPlanId` は呼び出し側から渡ってくる**（C-6 と同じ形） */
  it('他人の構成表IDを渡しても作れない', async () => {
    const otherUser = await createUser(prisma);
    const otherBlog = await createBlog(prisma, otherUser.id);
    const otherPlan = await prisma.contentPlan.create({
      data: {
        blogId: otherBlog.id,
        planType: 'INITIAL',
        version: 1,
        strategySnapshot: {},
      },
      select: { id: true },
    });

    await buildPlan();

    await expect(
      designTrafficArticlesForUser(
        {
          userId,
          blogId,
          contentPlanId: otherPlan.id,
          genreName: '節約',
        },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.planNotFound });
  });
});
