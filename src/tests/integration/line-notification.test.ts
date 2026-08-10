import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createLineClient } from '@/lib/line';
import {
  LINE_ERROR_CODES,
  sendEmergencyNotificationForUser,
  sendPendingProposalsForUser,
} from '@/modules/line';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 提案のLINE通知を**実PostgreSQL・実HTTPサーバーで**確かめる（TASKS F-2）。
 *
 * 完了条件は「**同一提案を連続通知しない**」。
 *
 * `fetch` を偽物に差し替えず、**実際にHTTPを話す**。ヘッダの付け方や
 * 本文の形が壊れていれば、偽物では気づけない。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;

interface ReceivedRequest {
  authorization: string | undefined;
  retryKey: string | undefined;
  body: Record<string, unknown>;
}

let received: ReceivedRequest[] = [];
let status = 200;

const ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
  LIFF_BASE_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        authorization: request.headers['authorization'],
        retryKey: request.headers['x-line-retry-key'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >,
      });

      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? {} : { message: 'error' }));
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

function client() {
  return createLineClient(
    { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
    { endpoint: baseUrl },
  );
}

async function createProposal(
  overrides: { priorityScore?: number; sentAt?: Date; blogId?: string } = {},
): Promise<string> {
  const targetBlogId = overrides.blogId ?? blogId;

  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: {
        blogId: targetBlogId,
        planType: 'INITIAL',
        version: 1,
      },
    },
    update: {},
    create: {
      blogId: targetBlogId,
      planType: 'INITIAL',
      version: 1,
      strategySnapshot: {},
    },
    select: { id: true },
  });

  const sequenceNo =
    (await prisma.contentItem.count({ where: { contentPlanId: plan.id } })) + 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: targetBlogId,
      sequenceNo,
      contentType: 'INFORMATIONAL',
      title: `記事${sequenceNo}`,
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: sequenceNo,
      status: 'READY_FOR_REVIEW',
    },
    select: { id: true },
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
      versionNo: 1,
      title: `タイトル${sequenceNo}`,
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
      blogId: targetBlogId,
      contentItemId: item.id,
      articleVersionId: version.id,
      status: 'PENDING',
      proposalType: 'NEW_ARTICLE',
      priorityScore: overrides.priorityScore ?? 100,
      proposalReason: '集客記事です。読者を収益記事へ誘導します。',
      ...(overrides.sentAt === undefined ? {} : { sentAt: overrides.sentAt }),
    },
    select: { id: true },
  });

  return approval.id;
}

/** `monitor_profiles.max_daily_proposals` を設定する */
async function setMaxDailyProposals(value: number): Promise<void> {
  await prisma.monitorProfile.upsert({
    where: { userId },
    update: { maxDailyProposals: value },
    create: {
      userId,
      primaryAspNames: [],
      notificationDays: [1],
      notificationTime: new Date('1970-01-01T09:00:00.000Z'),
      maxDailyProposals: value,
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
  status = 200;

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, user.id, { name: '格安SIMブログ' });
  blogId = blog.id;
});

describe('提案を送る（SPEC 8.2）', () => {
  it('LINE へ push される', async () => {
    const approvalId = await createProposal();

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toEqual([approvalId]);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(
      `Bearer ${ENV.LINE_CHANNEL_ACCESS_TOKEN}`,
    );
  });

  it('本文にブログ名と記事タイトルが載る', async () => {
    await createProposal();

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    const body = JSON.stringify(received[0]?.body);

    expect(body).toContain('格安SIMブログ');
    expect(body).toContain('タイトル1');
  });

  it('宛先は line_user_id', async () => {
    await createProposal();

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lineUserId: true },
    });

    expect(received[0]?.body['to']).toBe(user?.lineUserId);
  });

  it('送った提案に sent_at が入る', async () => {
    const approvalId = await createProposal();

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { sentAt: true },
    });

    expect(approval?.sentAt).not.toBeNull();
  });

  it('提案が無ければ何も送らない', async () => {
    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toEqual([]);
    expect(received).toEqual([]);
  });
});

describe('同一提案を連続通知しない（完了条件）', () => {
  it('2回目は送らない', async () => {
    await createProposal();

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );
    const second = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(second.sent).toEqual([]);
    expect(received).toHaveLength(1);
  });

  it('既に送信済みの提案は対象にならない', async () => {
    await createProposal({ sentAt: new Date('2026-08-09T00:00:00.000Z') });

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toEqual([]);
    expect(received).toEqual([]);
  });

  /** **LINE 側でも止める。** 再試行が届いても二重にならない */
  it('retry key に承認IDを渡す', async () => {
    const approvalId = await createProposal();

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(received[0]?.retryKey).toBe(approvalId);
  });

  /**
   * **送る前に `sent_at` を立てる。** 送ってから立てると、
   * 送信の直後に落ちたときに二度届く
   */
  it('送信に失敗しても sent_at は立ったまま', async () => {
    const approvalId = await createProposal();
    status = 500;

    await expect(
      sendPendingProposalsForUser(userId, {}, { client: client(), env: ENV }),
    ).rejects.toThrow();

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { sentAt: true },
    });

    // 提案は承認一覧（F-4）に残るので消えはしない
    expect(approval?.sentAt).not.toBeNull();
  });
});

describe('1日の件数（F-3、SPEC 8.3）', () => {
  it('既定は1件', async () => {
    await createProposal({ priorityScore: 100 });
    await createProposal({ priorityScore: 50 });

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toHaveLength(1);
  });

  it('優先度の高いものから送る', async () => {
    await createProposal({ priorityScore: 10 });
    const high = await createProposal({ priorityScore: 999 });

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toEqual([high]);
  });

  /** SPEC 8.3「最大：1日2件」 */
  it('上限を2件にすれば2件送る', async () => {
    await setMaxDailyProposals(2);
    await createProposal({ priorityScore: 100 });
    await createProposal({ priorityScore: 50 });

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toHaveLength(2);
    expect(received).toHaveLength(2);
  });

  /** **呼び出し側の指定は「それ以下に絞る」ためだけに効く** */
  it('呼び出し側は上限を超えられない', async () => {
    await createProposal({ priorityScore: 100 });
    await createProposal({ priorityScore: 50 });

    const result = await sendPendingProposalsForUser(
      userId,
      { limit: 10 },
      { client: client(), env: ENV },
    );

    expect(result.sent).toHaveLength(1);
  });

  /**
   * **DBは3以上も入る。** 設定画面の検証だけに頼ると、直接書き換えられた
   * 値がそのまま効く
   */
  it('3件以上に設定されていても2件で止まる', async () => {
    await setMaxDailyProposals(5);
    for (const score of [100, 90, 80, 70]) {
      await createProposal({ priorityScore: score });
    }

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toHaveLength(2);
  });

  it('使い切ったら送らない', async () => {
    await createProposal({ priorityScore: 100 });
    await createProposal({ priorityScore: 50 });

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );
    const second = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(second.sent).toEqual([]);
    expect(second.remaining).toBe(0);
    expect(received).toHaveLength(1);
  });

  /**
   * **「3ブログ合計で制限」は、数える単位が利用者だということ。**
   * ブログごとに数えると3ブログ持つ人には1日3件届く
   */
  it('別のブログの提案でも同じ枠を使う', async () => {
    const second = await createBlog(prisma, userId, {
      slotNumber: 2,
      name: '2つめのブログ',
    });

    await createProposal({ priorityScore: 100 });
    await createProposal({ priorityScore: 50, blogId: second.id });

    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );
    const again = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(again.sent).toEqual([]);
    expect(received).toHaveLength(1);
  });

  /**
   * **JSTの暦日で数える。** UTCで数えると日本の1日が2日にまたがり、
   * 夜に届いた1件が翌日の枠を1つ消す
   */
  it('昨日送った分は今日の枠を使わない', async () => {
    // JST 2026-08-09 23:00 = UTC 2026-08-09 14:00
    await createProposal({ sentAt: new Date('2026-08-09T14:00:00.000Z') });
    await createProposal({ priorityScore: 50 });

    // JST 2026-08-10 09:00
    const result = await sendPendingProposalsForUser(
      userId,
      {},
      {
        client: client(),
        env: ENV,
        now: new Date('2026-08-10T00:00:00.000Z'),
      },
    );

    expect(result.sent).toHaveLength(1);
  });

  it('同じJSTの日に送った分は枠を使う', async () => {
    // JST 2026-08-10 09:00 = UTC 2026-08-10 00:00
    await createProposal({ sentAt: new Date('2026-08-10T00:00:00.000Z') });
    await createProposal({ priorityScore: 50 });

    // JST 2026-08-10 23:00 = UTC 2026-08-10 14:00
    const result = await sendPendingProposalsForUser(
      userId,
      {},
      {
        client: client(),
        env: ENV,
        now: new Date('2026-08-10T14:00:00.000Z'),
      },
    );

    expect(result.sent).toEqual([]);
  });
});

describe('緊急通知は別枠（完了条件）', () => {
  /**
   * **提案の枠と同じ数え方にすると、「今日は1件送ったので接続切れを
   * 知らせない」が起きる**
   */
  it('提案の枠を使い切っていても送れる', async () => {
    await createProposal();
    await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    await sendEmergencyNotificationForUser(
      userId,
      {
        kind: 'WORDPRESS_DISCONNECTED',
        blogName: '格安SIMブログ',
        detail: '接続を確認してください',
      },
      { client: client(), env: ENV },
    );

    expect(received).toHaveLength(2);
    expect(JSON.stringify(received[1]?.body)).toContain('WordPress接続切れ');
  });

  /** 緊急通知は `approvals` の行を作らないので、枠を消費しようがない */
  it('緊急通知は提案の枠を減らさない', async () => {
    await sendEmergencyNotificationForUser(
      userId,
      {
        kind: 'LINK_BROKEN',
        blogName: 'ブログ',
        detail: 'リンクが切れています',
      },
      { client: client(), env: ENV },
    );

    await createProposal();

    const result = await sendPendingProposalsForUser(
      userId,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toHaveLength(1);
  });

  it('ACTIVE でない利用者には緊急通知も送らない', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'PAUSED' },
    });

    await expect(
      sendEmergencyNotificationForUser(
        userId,
        { kind: 'OFFER_ENDED', blogName: 'ブログ', detail: '終了しました' },
        { client: client(), env: ENV },
      ),
    ).rejects.toMatchObject({ code: LINE_ERROR_CODES.targetMissing });
  });
});

describe('送れない状態を黙って通さない', () => {
  it('設定が無ければ落ちる', async () => {
    await createProposal();

    await expect(
      sendPendingProposalsForUser(
        userId,
        {},
        {
          client: client(),
          env: { LINE_CHANNEL_ACCESS_TOKEN: 'x'.repeat(30) },
        },
      ),
    ).rejects.toMatchObject({ code: LINE_ERROR_CODES.notConfigured });

    expect(received).toEqual([]);
  });

  /** **停止した利用者に提案が届くと、止めたはずのものが動いて見える** */
  it('ACTIVE でない利用者には送らない', async () => {
    await createProposal();
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'PAUSED' },
    });

    await expect(
      sendPendingProposalsForUser(userId, {}, { client: client(), env: ENV }),
    ).rejects.toMatchObject({ code: LINE_ERROR_CODES.targetMissing });

    expect(received).toEqual([]);
  });

  /** **宛先が無いと分かるのは押さえる前。** 送っていない提案に印を付けない */
  it('宛先が無くても sent_at を立てない', async () => {
    const approvalId = await createProposal();
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'PAUSED' },
    });

    await expect(
      sendPendingProposalsForUser(userId, {}, { client: client(), env: ENV }),
    ).rejects.toThrow();

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { sentAt: true },
    });

    expect(approval?.sentAt).toBeNull();
  });
});

describe('他人の提案は送らない', () => {
  it('別の利用者の提案は対象にならない', async () => {
    await createProposal();

    const other = await createUser(prisma);

    const result = await sendPendingProposalsForUser(
      other.id,
      {},
      { client: client(), env: ENV },
    );

    expect(result.sent).toEqual([]);
    expect(received).toEqual([]);
  });
});
