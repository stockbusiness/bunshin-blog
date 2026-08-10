import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import {
  approveForUser,
  requestRevisionForUser,
  skipForUser,
} from '@/modules/approvals';
import { claimNextJob, completeJob } from '@/modules/jobs';
import {
  connectWordpressForUser,
  testWordpressConnectionForUser,
  type WordpressApiResponse,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 承認から WordPress への下書き投稿までを通しで確かめる（TASKS F-7）。
 *
 * 完了条件は「**承認→下書き投稿がE2Eで成功**」。
 *
 * 経路は3段。**どこか1つでも切れていれば落ちる。**
 *
 * 1. 承認すると同じトランザクションで `WORDPRESS_POST` が積まれる
 * 2. ジョブを引くとハンドラが承認した版を投稿する
 * 3. 投稿できてから記事が `POSTED` になる
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let approvalId: string;
let contentItemId: string;
let articleVersionId: string;
let requests: WordpressRequest[] = [];

const NOW = new Date('2026-08-10T00:00:00.000Z');
const SITE_URL = 'https://monitor-blog.example.com';

let nextWpPostId = 4242;

function respond(request: WordpressRequest): Partial<WordpressApiResponse> {
  const method = (request.method ?? 'GET').toUpperCase();

  if (request.path === '/') {
    return { status: 200, json: { namespaces: ['wp/v2'] } };
  }

  if (request.path.startsWith('/wp/v2/users/me')) {
    return {
      status: 200,
      json: { id: 1, capabilities: { upload_files: true } },
    };
  }

  if (request.path === '/wp/v2/posts' && method === 'POST') {
    nextWpPostId += 1;

    return {
      status: 201,
      json: {
        id: nextWpPostId,
        status: 'draft',
        link: `${SITE_URL}/?p=${nextWpPostId}`,
        content: { raw: (request.body as { content?: string })?.content ?? '' },
      },
    };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

function clientFactory(): WordpressClient {
  return {
    async request(request) {
      requests.push(request);
      const result = respond(request);

      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        json: result.json ?? null,
        raw: JSON.stringify(result.json ?? null),
      };
    },
  };
}

const handlers = createJobHandlers({ wordpressClientFactory: clientFactory });

/** 積まれたジョブを1件引いて実行する（本番と同じ経路） */
async function runNextJob(): Promise<unknown> {
  const job = await claimNextJob(Object.keys(handlers));

  if (job === null) {
    throw new Error('ジョブが積まれていない');
  }

  const handler = handlers[job.jobType as keyof typeof handlers];

  if (handler === undefined) {
    throw new Error(`ハンドラが無い: ${job.jobType}`);
  }

  const output = await handler(job);
  await completeJob(job.id, output);

  return output;
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

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;

  await connectWordpressForUser(
    { userId, blogId },
    {
      siteUrl: SITE_URL,
      wpUsername: 'monitor',
      appPassword: 'pass word abcd efgh ijkl',
    },
  );
  // C-2 を通さないと投稿できない
  await testWordpressConnectionForUser({ userId, blogId }, clientFactory);

  const plan = await prisma.contentPlan.create({
    data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: 1,
      contentType: 'INFORMATIONAL',
      title: '記事',
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: 1,
      status: 'READY_FOR_REVIEW',
    },
    select: { id: true },
  });
  contentItemId = item.id;

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId,
      versionNo: 1,
      title: '承認されたタイトル',
      excerpt: '要約',
      answerCapsule: '結論',
      bodyHtml: '<p>承認された本文</p>',
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
      contentHash: 'a'.repeat(64),
    },
    select: { id: true },
  });
  articleVersionId = version.id;

  const approval = await prisma.approval.create({
    data: {
      userId,
      blogId,
      contentItemId,
      articleVersionId,
      status: 'PENDING',
      proposalType: 'NEW_ARTICLE',
      priorityScore: 100,
      proposalReason: '理由',
      sentAt: NOW,
    },
    select: { id: true },
  });
  approvalId = approval.id;

  // **接続テスト（C-2）の投稿を数えない。** 準備が済んでから記録を始める
  requests = [];
});

describe('承認 → 下書き投稿（完了条件）', () => {
  it('承認すると投稿ジョブが積まれる', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const job = await prisma.job.findFirst({
      where: { jobType: 'WORDPRESS_POST' },
      select: { targetId: true, userId: true, blogId: true, inputJson: true },
    });

    expect(job?.targetId).toBe(contentItemId);
    expect(job?.userId).toBe(userId);
    expect(job?.blogId).toBe(blogId);
    expect(job?.inputJson).toMatchObject({ articleVersionId });
  });

  it('ジョブを実行すると下書きが投稿される', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const output = (await runNextJob()) as { wpStatus: string };

    expect(output.wpStatus).toBe('DRAFT');

    const posted = requests.find(
      (request) =>
        request.path === '/wp/v2/posts' &&
        (request.method ?? 'GET').toUpperCase() === 'POST',
    );

    expect(posted).toBeDefined();
    expect(posted?.body).toMatchObject({
      title: '承認されたタイトル',
      content: '<p>承認された本文</p>',
      status: 'draft',
    });
  });

  it('wordpress_posts に記録される', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    await runNextJob();

    const post = await prisma.wordpressPost.findFirst({
      where: { contentItemId },
      select: { wpStatus: true, blogId: true },
    });

    expect(post?.wpStatus).toBe('DRAFT');
    expect(post?.blogId).toBe(blogId);
  });

  /** **投稿できてから状態を進める** */
  it('投稿できると記事が POSTED になる', async () => {
    await approveForUser({ userId, approvalId, now: NOW });

    const before = await prisma.contentItem.findUnique({
      where: { id: contentItemId },
      select: { status: true },
    });

    expect(before?.status).toBe('APPROVED');

    await runNextJob();

    const after = await prisma.contentItem.findUnique({
      where: { id: contentItemId },
      select: { status: true },
    });

    expect(after?.status).toBe('POSTED');
  });

  /** **公開はモニターが WordPress 側で行う**（SPEC 7） */
  it('公開せず下書きのまま置く', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    await runNextJob();

    const published = requests.filter((request) =>
      JSON.stringify(request.body ?? {}).includes('"publish"'),
    );

    expect(published).toEqual([]);
  });
});

describe('承認しなければ投稿しない', () => {
  it('見送りでは積まれない', async () => {
    await skipForUser({ userId, approvalId, now: NOW });

    expect(
      await prisma.job.count({ where: { jobType: 'WORDPRESS_POST' } }),
    ).toBe(0);
  });

  it('修正依頼では積まれない', async () => {
    await requestRevisionForUser({
      userId,
      approvalId,
      requestType: 'SHORTER',
      now: NOW,
    });

    expect(
      await prisma.job.count({ where: { jobType: 'WORDPRESS_POST' } }),
    ).toBe(0);
  });

  /** **承認とジョブは同時に決まる**（片方だけ残らない） */
  it('他人が承認しようとしても積まれない', async () => {
    const other = await createUser(prisma);

    await expect(
      approveForUser({ userId: other.id, approvalId, now: NOW }),
    ).rejects.toThrow();

    expect(
      await prisma.job.count({ where: { jobType: 'WORDPRESS_POST' } }),
    ).toBe(0);
  });
});

describe('二重投稿しない', () => {
  /** 二度承認しても失敗させない（F-6 の冪等性）。ジョブは1件のまま */
  it('二度承認してもジョブは1件', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    await approveForUser({ userId, approvalId, now: NOW });

    expect(
      await prisma.job.count({ where: { jobType: 'WORDPRESS_POST' } }),
    ).toBe(1);
  });

  /** ジョブを再実行しても WordPress を呼び直さない（C-5 の抑止） */
  it('同じ内容ならジョブを再実行しても投稿し直さない', async () => {
    await approveForUser({ userId, approvalId, now: NOW });
    await runNextJob();

    const firstCount = requests.filter(
      (request) =>
        request.path === '/wp/v2/posts' &&
        (request.method ?? 'GET').toUpperCase() === 'POST',
    ).length;

    // 同じ入力でハンドラをもう一度呼ぶ
    await handlers.WORDPRESS_POST?.({
      id: 'job-2',
      jobType: 'WORDPRESS_POST',
      userId,
      blogId,
      targetId: contentItemId,
      status: 'RUNNING',
      attemptCount: 1,
      idempotencyKey: 'WORDPRESS_POST:manual',
      input: { articleVersionId },
      output: null,
      errorCode: null,
      errorMessage: null,
      startedAt: NOW,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const secondCount = requests.filter(
      (request) =>
        request.path === '/wp/v2/posts' &&
        (request.method ?? 'GET').toUpperCase() === 'POST',
    ).length;

    expect(secondCount).toBe(firstCount);
  });
});
