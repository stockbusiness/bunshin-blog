import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import { runProposalNotify } from '@/app/api/jobs/run/schedule';
import { createAiProvider } from '@/lib/ai';
import { createLineClient } from '@/lib/line';
import { refreshProposalsForUser } from '@/modules/approvals';
import { drainJobs, enqueueJob } from '@/modules/jobs';
import { createPromptVersionForAdmin } from '@/modules/content-generation';
import { sendEmergencyNotificationForUser } from '@/modules/line';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * SPEC 15.4 の最低条件を確かめる（TASKS I-6）。
 *
 * | 条件 | どこで見るか |
 * |---|---|
 * | 10ユーザー・30ブログ | すべての試験の土台 |
 * | 30件同時記事生成ジョブ | 「30件を積んで消化する」 |
 * | 1日60件通知 | 「1日に60件送れる」 |
 * | 月300〜600記事処理履歴 | 「履歴が積み上がっても選定が動く」 |
 * | ジョブ再実行時の重複なし | 「二度積んでも増えない」 |
 *
 * ## 速さは測らない
 *
 * **CI の実行機は本番と違う。** 秒数で判定すると、混んだ日に落ちる
 * 試験になり、**落ちても誰も原因を見なくなる。** ここで見るのは
 * **件数が正しいこと**と、**壊れないこと。**
 *
 * 本番の速さは、実機で測る（未実施）。
 */

const USERS = 10;
const BLOGS_PER_USER = 3;
/** SPEC 15.4「30件同時記事生成ジョブ」 */
const CONCURRENT_ARTICLES = 30;
/** SPEC 15.4「1日60件通知」 */
const DAILY_NOTIFICATIONS = 60;
/** SPEC 15.4「月300〜600記事処理履歴」。**下限で見る**（上限は時間がかかる） */
const HISTORY_ARTICLES = 300;

let prisma: PrismaClient;
let aiServer: Server;
let lineServer: Server;
let aiBaseUrl: string;
let lineBaseUrl: string;
let linePushes = 0;

const ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
  LIFF_BASE_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

const CAPSULE =
  'この記事では、月額500円から使える格安SIMの選び方を、通信速度・料金・サポート体制の3つの観点から比較し、初めて乗り換える方が失敗しないための手順まで具体的に説明します。';

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function answerFor(input: Record<string, unknown>): unknown {
  if ('contentItem' in input) {
    return {
      title: '生成されたタイトル',
      excerpt: '要約',
      answerCapsule: CAPSULE,
      bodyHtml: '<p>本記事は広告を含みます。</p>',
      faq: [
        { question: '料金は？', answer: '月額500円です' },
        { question: '解約は？', answer: 'いつでもできます' },
        { question: '対応端末は？', answer: '主要な機種に対応しています' },
      ],
      usedFactIds: [],
      claims: [],
    };
  }

  return { claims: [] };
}

function startServers(): Promise<void[]> {
  aiServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { content: string }[];
      };
      const input = JSON.parse(body.messages[0]?.content ?? '{}') as Record<
        string,
        unknown
      >;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(aiText(answerFor(input)));
    });
  });

  lineServer = createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      linePushes += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  return Promise.all([
    new Promise<void>((resolve) => {
      aiServer.listen(0, '127.0.0.1', () => {
        const address = aiServer.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : 0;
        aiBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      lineServer.listen(0, '127.0.0.1', () => {
        const address = lineServer.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : 0;
        lineBaseUrl = `http://127.0.0.1:${port}/push`;
        resolve();
      });
    }),
  ]);
}

function handlers() {
  return createJobHandlers({
    aiProvider: createAiProvider({
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      baseUrl: aiBaseUrl,
    }),
  });
}

function lineDeps(now: Date) {
  return {
    client: createLineClient(
      { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
      { endpoint: lineBaseUrl },
    ),
    env: ENV,
    now,
  };
}

interface Tenant {
  userId: string;
  blogIds: string[];
}

let tenants: Tenant[] = [];

/** 10ユーザー×3ブログ＝30ブログ（SPEC 15.4・Phase 0 の規模） */
async function createTenants(): Promise<void> {
  tenants = [];

  for (let index = 0; index < USERS; index += 1) {
    const user = await createUser(prisma, { displayName: `モニター${index}` });
    const blogIds: string[] = [];

    for (let slot = 1; slot <= BLOGS_PER_USER; slot += 1) {
      const blog = await createBlog(prisma, user.id, {
        name: `ブログ${index}-${slot}`,
        slotNumber: slot,
      });

      blogIds.push(blog.id);
    }

    tenants.push({ userId: user.id, blogIds });
  }
}

/**
 * 記事を1本ぶんの行として入れる。
 *
 * **`createMany` でまとめて入れる。** 300件を1件ずつ往復させると、
 * 試験そのものが遅くて回されなくなる。
 */
async function seedItems(
  blogId: string,
  count: number,
  status: 'PLANNED' | 'POSTED',
): Promise<string[]> {
  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: { blogId, planType: 'INITIAL', version: 1 },
    },
    update: {},
    create: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const existing = await prisma.contentItem.count({
    where: { contentPlanId: plan.id },
  });

  await prisma.contentItem.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      contentPlanId: plan.id,
      blogId,
      sequenceNo: existing + index + 1,
      contentType: 'INFORMATIONAL' as const,
      title: `記事${existing + index + 1}`,
      searchIntent: '意図',
      objective: 'TRAFFIC' as const,
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: existing + index + 1,
      plannedPublishWeek: 1,
      status,
    })),
  });

  return prisma.contentItem
    .findMany({
      where: { contentPlanId: plan.id, status },
      select: { id: true },
      orderBy: { sequenceNo: 'asc' },
    })
    .then((rows) => rows.map((row) => row.id));
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServers();
});

afterAll(async () => {
  await prisma.$disconnect();
  await Promise.all([
    new Promise<void>((resolve) => aiServer.close(() => resolve())),
    new Promise<void>((resolve) => lineServer.close(() => resolve())),
  ]);
});

beforeEach(async () => {
  await resetDatabase(prisma);
  linePushes = 0;
});

describe('Phase 0 の規模（10ユーザー・30ブログ）', () => {
  it('30ブログを作れる', async () => {
    await createTenants();

    expect(await prisma.user.count()).toBe(USERS);
    expect(await prisma.blog.count()).toBe(USERS * BLOGS_PER_USER);
    // **分身1体につきブログ1つ**（A-2-R-2c）
    expect(await prisma.persona.count()).toBe(USERS * BLOGS_PER_USER);
  });
});

describe('30件同時記事生成ジョブ（SPEC 15.4）', () => {
  it('30件を積んで、すべて成功する', async () => {
    await createTenants();

    await createPromptVersionForAdmin({
      key: 'generation.article',
      version: 'v1',
      body: 'あなたは編集者です。',
      activate: true,
    });
    await createPromptVersionForAdmin({
      key: 'generation.claim_extraction',
      version: 'v1',
      body: '主張を抽出してください。',
      activate: true,
    });

    // 30ブログに1本ずつ＝30件
    for (const tenant of tenants) {
      for (const blogId of tenant.blogIds) {
        const [itemId] = await seedItems(blogId, 1, 'PLANNED');

        await enqueueJob({
          jobType: 'ARTICLE_GENERATION',
          idempotencyKey: `ARTICLE_GENERATION:${itemId as string}`,
          input: {},
          userId: tenant.userId,
          blogId,
          targetId: itemId as string,
        });
      }
    }

    expect(await prisma.job.count()).toBe(CONCURRENT_ARTICLES);

    const result = await drainJobs({
      registry: handlers(),
      deadline: new Date(Date.now() + 300_000),
    });

    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(CONCURRENT_ARTICLES);
    expect(await prisma.articleVersion.count()).toBe(CONCURRENT_ARTICLES);
  });
});

/**
 * **提案だけでは 60 件に届かない。** 1日に送れる提案は
 * **1人あたり最大2件**（SPEC 8.3・F-3）で、10人でも **20件が上限。**
 * 残りは緊急通知（H-3）で、**提案の枠を消費しない。**
 */
describe('1日60件通知（SPEC 15.4）', () => {
  it('提案20件＋緊急通知40件を1日で送れる', async () => {
    await createTenants();

    const now = new Date('2026-08-12T03:00:00.000Z');

    // 提案：1人2件×10人＝20件
    for (const tenant of tenants) {
      await prisma.monitorProfile.upsert({
        where: { userId: tenant.userId },
        update: { maxDailyProposals: 2, notificationDays: [] },
        create: {
          userId: tenant.userId,
          primaryAspNames: [],
          notificationDays: [],
          notificationTime: new Date('1970-01-01T09:00:00.000Z'),
          maxDailyProposals: 2,
        },
      });

      for (const blogId of tenant.blogIds.slice(0, 2)) {
        const [itemId] = await seedItems(blogId, 1, 'PLANNED');

        await prisma.contentItem.update({
          where: { id: itemId as string },
          data: { status: 'READY_FOR_REVIEW' },
        });

        const version = await prisma.articleVersion.create({
          data: {
            contentItemId: itemId as string,
            versionNo: 1,
            title: 'タイトル',
            excerpt: '要約',
            answerCapsule: '結論',
            bodyHtml: '<p>本文</p>',
            faqJson: [],
            structuredDataJson: [],
            factCheckStatus: 'PASSED',
            riskFlags: [],
            usedFactIds: [],
            unverifiedClaims: [],
            modelProvider: 'anthropic',
            modelName: 'test',
            promptVersion: 'v1',
            inputTokens: 1,
            outputTokens: 1,
            estimatedCostUsd: 0,
            contentHash: `${itemId as string}`.padEnd(64, 'x').slice(0, 64),
          },
          select: { id: true },
        });

        await prisma.approval.create({
          data: {
            userId: tenant.userId,
            blogId,
            contentItemId: itemId as string,
            articleVersionId: version.id,
            status: 'PENDING',
            proposalType: 'NEW_ARTICLE',
            priorityScore: 100,
            proposalReason: '集客記事です。読者を収益記事へ誘導します。',
          },
        });
      }
    }

    const notified = await runProposalNotify(lineDeps(now));

    expect(notified.failed).toBe(0);
    expect(notified.sent).toBe(20);

    // 緊急通知：40件（**提案の枠を消費しない**）
    for (let index = 0; index < 40; index += 1) {
      const tenant = tenants[index % USERS] as Tenant;

      await sendEmergencyNotificationForUser(
        tenant.userId,
        {
          kind: 'LINK_BROKEN',
          blogName: 'ブログ',
          detail: `${index}`,
        },
        lineDeps(now),
      );
    }

    expect(linePushes).toBe(DAILY_NOTIFICATIONS);
  });
});

/** **履歴が積み上がっても、選定が動き続ける** */
describe('月300記事の処理履歴（SPEC 15.4）', () => {
  it('300件の履歴があっても提案を選べる', async () => {
    await createTenants();

    const tenant = tenants[0] as Tenant;
    const blogId = tenant.blogIds[0] as string;

    // 投稿済みの履歴
    await seedItems(blogId, HISTORY_ARTICLES, 'POSTED');

    expect(await prisma.contentItem.count({ where: { blogId } })).toBe(
      HISTORY_ARTICLES,
    );

    // そのうえで、新しい記事を1本だけ承認へ送れる。
    //
    // **`READY_FOR_REVIEW` にしない。** その状態にするのは提案ができて
    // からで（F-1 の `markItemsReadyForReview`）、先に進めると
    // **選定の対象から外れる**
    const [itemId] = await seedItems(blogId, 1, 'PLANNED');

    await prisma.articleVersion.create({
      data: {
        contentItemId: itemId as string,
        versionNo: 1,
        title: 'タイトル',
        excerpt: '要約',
        answerCapsule: '結論',
        bodyHtml: '<p>本文</p>',
        faqJson: [],
        structuredDataJson: [],
        factCheckStatus: 'PASSED',
        riskFlags: [],
        usedFactIds: [],
        unverifiedClaims: [],
        modelProvider: 'anthropic',
        modelName: 'test',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
        estimatedCostUsd: 0,
        contentHash: `${itemId as string}`.padEnd(64, 'x').slice(0, 64),
      },
    });

    const proposals = await refreshProposalsForUser(tenant.userId);

    expect(proposals.created).toHaveLength(1);
  });
});

/**
 * **ジョブ再実行時の重複なし**（SPEC 15.4）。
 *
 * ここが崩れると、**同じ記事が二度 WordPress へ投稿される。**
 */
describe('二度積んでも増えない（SPEC 15.4）', () => {
  it('同じ冪等キーでは行が増えない', async () => {
    await createTenants();

    const tenant = tenants[0] as Tenant;
    const blogId = tenant.blogIds[0] as string;
    const [itemId] = await seedItems(blogId, 1, 'PLANNED');

    const key = `ARTICLE_GENERATION:${itemId as string}`;

    const first = await enqueueJob({
      jobType: 'ARTICLE_GENERATION',
      idempotencyKey: key,
      input: {},
      userId: tenant.userId,
      blogId,
      targetId: itemId as string,
    });
    const second = await enqueueJob({
      jobType: 'ARTICLE_GENERATION',
      idempotencyKey: key,
      input: {},
      userId: tenant.userId,
      blogId,
      targetId: itemId as string,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await prisma.job.count()).toBe(1);
  });

  /** **30件を二度積んでも30件のまま** */
  it('30件を二度積んでも30件のまま', async () => {
    await createTenants();

    const itemIds: string[] = [];

    for (const tenant of tenants) {
      for (const blogId of tenant.blogIds) {
        const [itemId] = await seedItems(blogId, 1, 'PLANNED');
        itemIds.push(itemId as string);
      }
    }

    for (let round = 0; round < 2; round += 1) {
      for (const itemId of itemIds) {
        const item = await prisma.contentItem.findUniqueOrThrow({
          where: { id: itemId },
          select: { blogId: true },
        });
        const owner = tenants.find((tenant) =>
          tenant.blogIds.includes(item.blogId),
        ) as Tenant;

        await enqueueJob({
          jobType: 'ARTICLE_GENERATION',
          idempotencyKey: `ARTICLE_GENERATION:${itemId}`,
          input: {},
          userId: owner.userId,
          blogId: item.blogId,
          targetId: itemId,
        });
      }
    }

    expect(await prisma.job.count()).toBe(CONCURRENT_ARTICLES);
  });
});
