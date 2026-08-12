import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  enqueueProposalNotify,
  runProposalNotify,
} from '@/app/api/jobs/run/schedule';
import { createLineClient } from '@/lib/line';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 提案の送信を積む経路を**実PostgreSQL・実HTTPサーバーで**確かめる
 * （TASKS I-2、SPEC 8.3）。
 *
 * **F-2 は「送る関数」まで作ったが、それを呼ぶ人がいなかった**
 * （棚卸し・2026-08-12）。提案は作られても、**LINE には一度も届かない**
 * 状態だった。
 *
 * ここで確かめるのは、**1時間ごとに試されること**と、
 * **時間帯の外では何もしないこと**（F-3b）。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;

let received: unknown[] = [];

const ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
  LIFF_BASE_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

/** 2026-08-12（水）12:00 JST */
const NOW = new Date('2026-08-12T03:00:00.000Z');

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}/push`;
      resolve();
    });
  });
}

function deps() {
  return {
    client: createLineClient(
      { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
      { endpoint: baseUrl },
    ),
    env: ENV,
    now: NOW,
  };
}

/**
 * 送れる状態の提案を1件作る。
 *
 * **曜日は空にする** — 未設定の扱いで時間帯の判定を素通しする。
 * 曜日を入れると**テストを走らせた日次第で送れたり送れなかったりする**
 * （F-3 の試験と同じ理由）。
 */
async function createPendingProposal(userId: string): Promise<string> {
  const blog = await createBlog(prisma, userId, { name: '格安SIMブログ' });

  const plan = await prisma.contentPlan.create({
    data: {
      blogId: blog.id,
      planType: 'INITIAL',
      version: 1,
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: blog.id,
      sequenceNo: 1,
      contentType: 'INFORMATIONAL',
      title: '記事1',
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: 1,
      status: 'READY_FOR_REVIEW',
    },
    select: { id: true },
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
      versionNo: 1,
      title: 'タイトル1',
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
      contentHash: `${item.id}`.padEnd(64, 'x').slice(0, 64),
    },
    select: { id: true },
  });

  const approval = await prisma.approval.create({
    data: {
      userId,
      blogId: blog.id,
      contentItemId: item.id,
      articleVersionId: version.id,
      status: 'PENDING',
      proposalType: 'NEW_ARTICLE',
      priorityScore: 100,
      proposalReason: '集客記事です。読者を収益記事へ誘導します。',
    },
    select: { id: true },
  });

  return approval.id;
}

/** 通知の曜日・時刻を設定する（F-3b） */
async function setNotificationSchedule(
  userId: string,
  days: number[],
  time: string,
): Promise<void> {
  await prisma.monitorProfile.upsert({
    where: { userId },
    update: {
      notificationDays: days,
      notificationTime: new Date(`1970-01-01T${time}:00.000Z`),
    },
    create: {
      userId,
      primaryAspNames: [],
      notificationDays: days,
      notificationTime: new Date(`1970-01-01T${time}:00.000Z`),
      maxDailyProposals: 1,
    },
  });
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
  received = [];
});

/**
 * **日次にできない。** 送ってよい時間帯はモニターごとに違い（F-3b）、
 * 積み込みが走る深夜とは限らない。1日1回しか試さないと、
 * **その人の朝が来る前に判定が終わり、提案は一度も届かない**
 */
describe('送信ジョブを積む', () => {
  it('その時間の1件だけを積む', async () => {
    expect(await enqueueProposalNotify({ now: NOW })).toBe(true);
    expect(await enqueueProposalNotify({ now: NOW })).toBe(false);

    expect(
      await prisma.job.count({ where: { jobType: 'PROPOSAL_NOTIFY' } }),
    ).toBe(1);
  });

  it('時が変われば積まれる', async () => {
    await enqueueProposalNotify({ now: NOW });

    // 1時間後
    expect(
      await enqueueProposalNotify({
        now: new Date(NOW.getTime() + 3_600_000),
      }),
    ).toBe(true);
    expect(
      await prisma.job.count({ where: { jobType: 'PROPOSAL_NOTIFY' } }),
    ).toBe(2);
  });

  /**
   * **同じ時でも日が違えば積む。** 冪等キーが時だけだと、
   * **翌日の同じ時刻に積まれない**
   */
  it('日が変われば同じ時でも積まれる', async () => {
    await enqueueProposalNotify({ now: NOW });

    expect(
      await enqueueProposalNotify({
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    ).toBe(true);
  });
});

describe('溜まっている提案を送る', () => {
  it('ACTIVE の利用者へ届く', async () => {
    const user = await createUser(prisma);
    const approvalId = await createPendingProposal(user.id);

    const result = await runProposalNotify(deps());

    expect(result).toMatchObject({ users: 1, sent: 1, failed: 0 });
    expect(received).toHaveLength(1);

    expect(
      (
        await prisma.approval.findUniqueOrThrow({
          where: { id: approvalId },
          select: { sentAt: true },
        })
      ).sentAt,
    ).not.toBeNull();
  });

  /**
   * **停止した利用者に提案が届くと、止めたはずのものが動いて見える**
   * （F-2）
   */
  it.each([
    { name: '招待しただけ', status: 'INVITED' as const },
    { name: '停止中', status: 'PAUSED' as const },
    { name: '退会済み', status: 'WITHDRAWN' as const },
  ])('$name には送らない', async ({ status }) => {
    const user = await createUser(prisma);
    await createPendingProposal(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { status } });

    const result = await runProposalNotify(deps());

    expect(result).toMatchObject({ users: 0, sent: 0 });
    expect(received).toHaveLength(0);
  });

  /**
   * **時間帯の判定は `line` モジュールが持つ。** ここでは判定しない —
   * 2か所に置くと、どちらが効いているのか読めない（F-3b）
   */
  it('時間帯の外では送らない', async () => {
    const user = await createUser(prisma);
    await createPendingProposal(user.id);
    // 水曜の 07:00 指定。NOW は 12:00 JST なので3時間の幅を過ぎている
    await setNotificationSchedule(user.id, [3], '07:00');

    const result = await runProposalNotify(deps());

    expect(result).toMatchObject({ users: 1, sent: 0, outOfWindow: 1 });
    expect(received).toHaveLength(0);
  });

  it('時間帯の中なら送る', async () => {
    const user = await createUser(prisma);
    await createPendingProposal(user.id);
    // 水曜の 11:00 指定。NOW は 12:00 JST で3時間の幅の中
    await setNotificationSchedule(user.id, [3], '11:00');

    const result = await runProposalNotify(deps());

    expect(result).toMatchObject({ sent: 1, outOfWindow: 0 });
    expect(received).toHaveLength(1);
  });

  /** **二度送らない**（`sent_at` を先に立てる。F-2） */
  it('1時間後にもう一度走っても送り直さない', async () => {
    const user = await createUser(prisma);
    await createPendingProposal(user.id);

    await runProposalNotify(deps());
    const second = await runProposalNotify({
      ...deps(),
      now: new Date(NOW.getTime() + 3_600_000),
    });

    expect(second.sent).toBe(0);
    expect(received).toHaveLength(1);
  });

  /** **1人の失敗で全体を止めない** */
  it('宛先が無い利用者がいても他の人には届く', async () => {
    const broken = await createUser(prisma);
    await createPendingProposal(broken.id);
    // **LINE を連携していない利用者**（`line_user_id` が無い）
    await prisma.user.update({
      where: { id: broken.id },
      data: { lineUserId: null },
    });

    const healthy = await createUser(prisma);
    await createPendingProposal(healthy.id);

    const result = await runProposalNotify(deps());

    expect(result.users).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(received).toHaveLength(1);
  });

  /** **利用者が1人もいなくても落ちない**（実験開始前は普通にある） */
  it('利用者がいなくても落ちない', async () => {
    const result = await runProposalNotify(deps());

    expect(result).toMatchObject({ users: 0, sent: 0, failed: 0 });
  });
});
