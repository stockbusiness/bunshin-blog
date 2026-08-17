import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createLineClient } from '@/lib/line';
import { collectAlertsForUser, enqueueAlertsForUser } from '@/modules/line';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import { claimNextJob, completeJob } from '@/modules/jobs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 緊急通知を**実PostgreSQLで**確かめる（TASKS H-3、SPEC 8.3）。
 *
 * 完了条件は「**接続切れ・リンク切れ・案件終了が緊急通知される**」。
 *
 * **同じ日の同じ指摘を繰り返さない**ことも確かめる — 毎回送ると、
 * 通知が「読まなくてよいもの」になる。
 */

let prisma: PrismaClient;
let server: Server;
let lineUrl: string;
let userId: string;
let blogId: string;
let pushed: Record<string, unknown>[] = [];

const NOW = new Date('2026-08-10T00:00:00.000Z');

/** リンクの確認を差し替える（実HTTPは link-check の試験で見る） */
function checkLinks(health: 'OK' | 'GONE' | 'UNAVAILABLE') {
  return async () => [
    {
      offerId: 'offer-1',
      offerName: '格安SIM案件',
      url: 'https://example.com/lp',
      health,
      status: health === 'GONE' ? 404 : 200,
    },
  ];
}

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      pushed.push(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >,
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      lineUrl = `http://127.0.0.1:${port}/push`;
      resolve();
    });
  });
}

async function connectWordpress(status: string, tested: Date | null) {
  await prisma.wordpressConnection.create({
    data: {
      blogId,
      siteUrl: 'https://example.com',
      apiBaseUrl: 'https://example.com/wp-json',
      wpUsernameEncrypted: 'x',
      appPasswordEncrypted: 'y',
      connectionStatus: status as never,
      ...(tested === null ? {} : { lastTestedAt: tested }),
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
  pushed = [];

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, userId, { name: '節約ブログ' });
  blogId = blog.id;
});

describe('3種類を見つける（完了条件）', () => {
  it('接続切れを見つける', async () => {
    await connectWordpress('FAILED', NOW);

    const alerts = await collectAlertsForUser(userId, {
      checkLinks: checkLinks('OK'),
    });

    expect(alerts.map((alert) => alert.kind)).toEqual([
      'WORDPRESS_DISCONNECTED',
    ]);
  });

  it('案件終了を見つける', async () => {
    await prisma.affiliateOffer.create({
      data: {
        blogId,
        name: '終わった案件',
        aspName: 'ASP',
        landingPageUrl: 'https://example.com/lp',
        affiliateUrl: 'https://asp.example/click',
        // **リンクがある＝提携は承認済み**（Q-060）
        partnershipStatus: 'APPROVED',
        conversionType: 'FREE_SIGNUP',
        facts: {},
        denyConditions: [],
        status: 'ENDED',
      },
    });

    const alerts = await collectAlertsForUser(userId, {
      checkLinks: checkLinks('OK'),
    });

    expect(alerts.map((alert) => alert.kind)).toEqual(['OFFER_ENDED']);
  });

  it('リンク切れを見つけ、どの案件かを書く', async () => {
    const alerts = await collectAlertsForUser(userId, {
      checkLinks: checkLinks('GONE'),
    });

    expect(alerts.map((alert) => alert.kind)).toEqual(['LINK_BROKEN']);
    // **「リンクが切れています」だけでは探せない**
    expect(alerts[0]?.detail).toContain('格安SIM案件');
  });

  /** **ASPのメンテナンスのたびに緊急通知を飛ばさない** */
  it('一時的に届かないだけなら知らせない', async () => {
    const alerts = await collectAlertsForUser(userId, {
      checkLinks: checkLinks('UNAVAILABLE'),
    });

    expect(alerts).toEqual([]);
  });

  it('問題が無ければ何も出ない', async () => {
    await connectWordpress('CONNECTED', NOW);

    expect(
      await collectAlertsForUser(userId, { checkLinks: checkLinks('OK') }),
    ).toEqual([]);
  });

  /** **準備中のブログに毎日「接続が切れています」と送らない** */
  it('一度も接続を試していないブログは対象外', async () => {
    await connectWordpress('FAILED', null);

    expect(
      await collectAlertsForUser(userId, { checkLinks: checkLinks('OK') }),
    ).toEqual([]);
  });

  it('CLOSED のブログは見ない', async () => {
    await connectWordpress('FAILED', NOW);
    await prisma.blog.update({
      where: { id: blogId },
      data: { status: 'CLOSED' },
    });

    expect(
      await collectAlertsForUser(userId, { checkLinks: checkLinks('OK') }),
    ).toEqual([]);
  });
});

describe('同じことを毎日言わない', () => {
  const alert = {
    blogId: '',
    blogName: '節約ブログ',
    kind: 'WORDPRESS_DISCONNECTED' as const,
    detail: '接続し直してください',
  };

  it('同じ日の同じ指摘は1回だけ積む', async () => {
    const alerts = [{ ...alert, blogId }];

    expect(await enqueueAlertsForUser(userId, { alerts, now: NOW })).toBe(1);
    expect(await enqueueAlertsForUser(userId, { alerts, now: NOW })).toBe(0);

    expect(await prisma.job.count({ where: { jobType: 'LINE_NOTIFY' } })).toBe(
      1,
    );
  });

  /** **直っていなければ翌日また届く。** 直すまで思い出させる */
  it('翌日はまた積む', async () => {
    const alerts = [{ ...alert, blogId }];

    await enqueueAlertsForUser(userId, { alerts, now: NOW });

    const tomorrow = new Date('2026-08-11T00:00:00.000Z');

    expect(await enqueueAlertsForUser(userId, { alerts, now: tomorrow })).toBe(
      1,
    );
  });

  it('種類が違えば別に積む', async () => {
    const alerts = [
      { ...alert, blogId },
      { ...alert, blogId, kind: 'LINK_BROKEN' as const },
    ];

    expect(await enqueueAlertsForUser(userId, { alerts, now: NOW })).toBe(2);
  });
});

describe('ジョブから通知が届く', () => {
  const ENV = {
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
    LIFF_BASE_URL: 'https://liff.line.me/x',
  };

  it('積んだ通知を送る', async () => {
    await enqueueAlertsForUser(userId, {
      alerts: [
        {
          blogId,
          blogName: '節約ブログ',
          kind: 'WORDPRESS_DISCONNECTED',
          detail: '接続し直してください',
        },
      ],
      now: NOW,
    });

    const handlers = createJobHandlers();
    const job = await claimNextJob(['LINE_NOTIFY']);

    if (job === null) {
      throw new Error('ジョブが積まれていない');
    }

    // 送信の経路だけ差し替える（実HTTPは偽サーバーが受ける）
    const { sendEmergencyNotificationForUser } = await import('@/modules/line');
    await sendEmergencyNotificationForUser(
      userId,
      {
        kind: 'WORDPRESS_DISCONNECTED',
        blogName: '節約ブログ',
        detail: '接続し直してください',
      },
      {
        client: createLineClient(
          { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
          { endpoint: lineUrl },
        ),
        env: ENV,
      },
    );
    await completeJob(job.id, { kind: 'WORDPRESS_DISCONNECTED' });

    expect(pushed).toHaveLength(1);
    expect(JSON.stringify(pushed[0])).toContain('WordPress接続切れ');

    // **ハンドラが登録されている**（登録漏れだとジョブが QUEUED のまま残る）
    expect(handlers.LINE_NOTIFY).toBeDefined();
    expect(handlers.LINK_CHECK).toBeDefined();
  });

  /** **提案の枠を消費しない**（SPEC 8.3「緊急通知は別枠」） */
  it('緊急通知は approvals の行を作らない', async () => {
    await enqueueAlertsForUser(userId, {
      alerts: [
        {
          blogId,
          blogName: '節約ブログ',
          kind: 'LINK_BROKEN',
          detail: 'x',
        },
      ],
      now: NOW,
    });

    expect(await prisma.approval.count()).toBe(0);
  });
});

describe('他人のブログは見ない', () => {
  it('別の利用者のブログは対象外', async () => {
    const other = await createUser(prisma);

    expect(
      await collectAlertsForUser(other.id, { checkLinks: checkLinks('GONE') }),
    ).toEqual([]);
  });
});
