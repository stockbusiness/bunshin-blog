import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import {
  INBOUND_MIN,
  MAX_PLAN_RETRIES,
  PLANNING_ERROR_CODES,
  buildPlanForUser,
} from '@/modules/content-planning';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 制約チェックと再生成ループを**実PostgreSQL・実HTTPサーバーで**確かめる
 * （TASKS E-8、SPEC 9.2.6）。
 *
 * 完了条件は2つ。
 *
 * 1. **SPEC 9.2.6 の全項目を判定する**
 * 2. **3回で収束しなければ FAILED**（暫定的な構成表を返さない）
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;
let offerId: string;

let handlers: Record<string, (input: Record<string, unknown>) => unknown>;
/** `searchIntents` が1本の収益記事あたり何件返すか */
let intentsPerItem: number;

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function classify(input: Record<string, unknown>): string {
  if ('slots' in input) return 'revenueTitles';
  if ('revenueItems' in input) return 'searchIntents';
  if ('conflicts' in input) return 'keywordConflict';
  if ('intents' in input) return 'keywords';

  return 'unknown';
}

/** 呼び出しごとに違うキーワードを返す（版をまたいで重複させない） */
let keywordSequence = 0;

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

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://example.com/lp',
      affiliateUrl: 'https://example.com/go',
      conversionType: 'FREE_SIGNUP',
      rewardYen: 10_000,
      facts: {},
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  offerId = offer.id;

  keywordSequence = 0;
  intentsPerItem = INBOUND_MIN;

  handlers = {
    revenueTitles: (input) => ({
      items: (input['slots'] as { slotId: string }[]).map((slot) => {
        keywordSequence += 1;

        return {
          slotId: slot.slotId,
          title: `収益記事${keywordSequence}`,
          primaryKeyword: `収益キーワード${keywordSequence}`,
          searchIntent: '意図',
        };
      }),
    }),
    searchIntents: (input) => ({
      intents: (input['revenueItems'] as { itemId: string }[]).flatMap((item) =>
        Array.from({ length: intentsPerItem }, (_, index) => ({
          revenueItemId: item.itemId,
          intent: `意図${index}`,
          readerState: '状態',
        })),
      ),
    }),
    keywords: (input) => ({
      items: (input['intents'] as { intentId: string }[]).map((intent) => {
        keywordSequence += 1;

        return {
          intentId: intent.intentId,
          title: `集客記事${keywordSequence}`,
          primaryKeyword: `集客キーワード${keywordSequence}`,
          contentType: 'INFORMATIONAL',
        };
      }),
    }),
    keywordConflict: (input) => ({
      items: (input['conflicts'] as { intentId: string }[]).map((conflict) => {
        keywordSequence += 1;

        return {
          intentId: conflict.intentId,
          title: `差し替え${keywordSequence}`,
          primaryKeyword: `差し替えキーワード${keywordSequence}`,
        };
      }),
    }),
  };
});

describe('通る構成表', () => {
  it('一発で通れば retries は 0', async () => {
    const result = await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    expect(result.result.passed).toBe(true);
    expect(result.retries).toBe(0);
    expect(result.attempts).toHaveLength(1);
  });

  /** **試行のたびに記録する。** 再生成の回数がプロンプト改善の指標になる */
  it('試行が planning_runs に残る', async () => {
    await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    const runs = await prisma.planningRun.findMany({
      where: { blogId },
      select: { retryCount: true, succeeded: true, constraintResult: true },
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryCount).toBe(0);
    expect(runs[0]?.succeeded).toBe(true);
    expect(runs[0]?.constraintResult).toMatchObject({ passed: true });
  });

  it('収益記事と集客記事が揃う', async () => {
    const result = await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    );

    // 収益3本（AFFILIATE 2 + COMPARISON 1）＋ 集客6本
    expect(result.items).toHaveLength(9);
    expect(result.result.counts).toEqual({
      total: 9,
      revenue: 3,
      traffic: 6,
    });
  });
});

describe('収束しない場合（完了条件）', () => {
  /**
   * **暫定的な構成表を返さない**（SPEC 9.2.6）。
   * 「だいたい通った」ものを承認依頼へ送ると、制約チェックの意味が無くなる。
   */
  it('3回やり直しても通らなければ落とす', async () => {
    // 収益記事1本あたり1件しか意図を返さない → 流入が3本に満たない
    intentsPerItem = 1;

    await expect(
      buildPlanForUser(
        { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({
      code: PLANNING_ERROR_CODES.notConverged,
      status: 500,
    });
  });

  it('4回試して諦める（初回＋3回）', async () => {
    intentsPerItem = 1;

    await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    ).catch(() => undefined);

    const runs = await prisma.planningRun.findMany({
      where: { blogId },
      orderBy: { retryCount: 'asc' },
      select: { retryCount: true, succeeded: true },
    });

    expect(runs).toHaveLength(MAX_PLAN_RETRIES + 1);
    expect(runs.map((run) => run.retryCount)).toEqual([0, 1, 2, 3]);
    expect(runs.every((run) => !run.succeeded)).toBe(true);
  });

  /** 落ちた理由が残らないと、原因の分析ができない */
  it('違反の内容が記録に残る', async () => {
    intentsPerItem = 1;

    await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    ).catch(() => undefined);

    const run = await prisma.planningRun.findFirst({
      where: { blogId },
      select: { constraintResult: true },
    });

    expect(JSON.stringify(run?.constraintResult)).toContain('inbound_too_few');
  });

  /** **やり直しは版を増やして作る。** 前の構成表を書き換えない */
  it('やり直しのたびに構成表の版が増える', async () => {
    intentsPerItem = 1;

    await buildPlanForUser(
      { userId, blogId, genreName: '節約', adoptedOfferIds: [offerId] },
      { provider: provider() },
    ).catch(() => undefined);

    const plans = await prisma.contentPlan.findMany({
      where: { blogId },
      orderBy: { version: 'asc' },
      select: { version: true },
    });

    expect(plans.map((plan) => plan.version)).toEqual([1, 2, 3, 4]);
  });
});

describe('他人のブログでは組み立てられない', () => {
  it('他人のブログIDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      buildPlanForUser(
        {
          userId,
          blogId: otherBlog.id,
          genreName: '節約',
          adoptedOfferIds: [offerId],
        },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.contentPlan.count()).toBe(0);
  });
});
