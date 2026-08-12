import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createLineClient } from '@/lib/line';
import { verifyLineSignature } from '@/lib/line';
import { recordLineReplyForUser } from '@/modules/line';
import { listPersonaFactsForUser } from '@/modules/personas';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * LINE返信の取り込みを**実PostgreSQLで**確かめる（TASKS D-7b、SPEC 8.4）。
 *
 * 完了条件は「返信が `persona_facts` に保存される」。
 *
 * **保存できないときに何をするか**も同じだけ確かめる — 分身が2体以上ある
 * ときに取り違えると、**その分身が持っていない経験を持つことになる。**
 */

let prisma: PrismaClient;
let server: Server;
let lineUrl: string;
let pushed: Record<string, unknown>[] = [];

const CHANNEL_SECRET = 'channel-secret-0123456789abcdef';

const ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
  LINE_CHANNEL_SECRET: CHANNEL_SECRET,
  LIFF_BASE_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

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
      lineUrl =
        typeof address === 'object' && address !== null
          ? `http://127.0.0.1:${String(address.port)}/push`
          : '';
      resolve();
    });
  });
}

function deps() {
  return {
    env: ENV,
    client: createLineClient(
      { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
      { endpoint: lineUrl },
    ),
  };
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServer();
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await resetDatabase(prisma);
  pushed = [];
});

describe('保存できるとき', () => {
  it('商品の感想が persona_facts に入る', async () => {
    const user = await createUser(prisma);
    const persona = await createPersona(prisma, user.id);

    const result = await recordLineReplyForUser(
      { userId: user.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    expect(result).toEqual({
      kind: 'PRODUCT_REVIEW',
      outcome: 'SAVED',
      guided: false,
    });

    const facts = await listPersonaFactsForUser(user.id);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      personaId: persona.id,
      factType: 'PRODUCT_REVIEW',
      content: '先月から使ってみました',
      // **本人が書いたもの**。AIの推測ではない
      source: 'USER_INPUT',
      // **裏は取れていない。** 本人の申告と、確かめたことは別
      verification: 'UNVERIFIED',
      usableFirstPerson: true,
    });
  });

  /** **保存できたときは返事をしない。** 送ると、返信のたびに返事が届く */
  it('保存できたら案内を送らない', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);

    await recordLineReplyForUser(
      { userId: user.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    expect(pushed).toHaveLength(0);
  });

  /**
   * **迷った `FREE_ANSWER` は一人称で使わせない。**
   * 「使った」と決めつけて体験談にすると、嘘が本文に出る
   */
  it('自由回答は一人称で使えない', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);

    const result = await recordLineReplyForUser(
      { userId: user.id, text: '今週は忙しかったです', eventId: 'ev-1' },
      deps(),
    );

    expect(result.kind).toBe('FREE_ANSWER');

    const facts = await listPersonaFactsForUser(user.id);

    expect(facts[0]).toMatchObject({
      factType: 'OPINION',
      usableFirstPerson: false,
    });
  });

  /**
   * ジョブは実行の途中で落ちうる（E-1・C-4）。保存したあとに再実行されると
   * **同じ記憶が2つ並ぶ**
   */
  it('同じ返信を二度取り込んでも増えない', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);

    const input = {
      userId: user.id,
      text: '先月から使ってみました',
      eventId: 'ev-1',
    };

    await recordLineReplyForUser(input, deps());
    const second = await recordLineReplyForUser(input, deps());

    expect(second.outcome).toBe('ALREADY_SAVED');
    expect(await listPersonaFactsForUser(user.id)).toHaveLength(1);
  });
});

/**
 * **決められないなら保存しない**（推測を確定として保存しない）。
 * 案内だけ送る
 */
describe('保存しないとき', () => {
  it('修正希望は保存せず、承認画面へ案内する', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);

    const result = await recordLineReplyForUser(
      { userId: user.id, text: 'タイトルを直してください', eventId: 'ev-1' },
      deps(),
    );

    expect(result).toEqual({
      kind: 'REVISION_REQUEST',
      outcome: 'REVISION_REQUEST',
      guided: true,
    });
    expect(await listPersonaFactsForUser(user.id)).toHaveLength(0);
    expect(JSON.stringify(pushed)).toContain('/approvals');
  });

  /** 取り違えると、その分身が持っていない経験を持つことになる（Q-037） */
  it('分身が2体あるときは決めずに案内する', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);
    await createPersona(prisma, user.id);

    const result = await recordLineReplyForUser(
      { userId: user.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    expect(result.outcome).toBe('PERSONA_AMBIGUOUS');
    expect(await listPersonaFactsForUser(user.id)).toHaveLength(0);
    expect(JSON.stringify(pushed)).toContain('/personas');
  });

  it('分身が無いときは案内する', async () => {
    const user = await createUser(prisma);

    const result = await recordLineReplyForUser(
      { userId: user.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    expect(result.outcome).toBe('NO_PERSONA');
    expect(JSON.stringify(pushed)).toContain('/personas');
  });

  /**
   * **`ACTIVE` の分身だけを数える。** 下書きの分身へ記憶を足すと、
   * 使い始めたときに身に覚えのない経験が入っている
   */
  it('下書きの分身は数に入れない', async () => {
    const user = await createUser(prisma);
    await createPersona(prisma, user.id);
    await createPersona(prisma, user.id, { status: 'DRAFT' });

    const result = await recordLineReplyForUser(
      { userId: user.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    expect(result.outcome).toBe('SAVED');
  });

  /** **退会・停止した人へ送らない**（`findNotificationTargetForUser`） */
  it('停止した人には案内を送らない', async () => {
    const user = await createUser(prisma, { status: 'PAUSED' });

    const result = await recordLineReplyForUser(
      { userId: user.id, text: 'タイトルを直してください', eventId: 'ev-1' },
      deps(),
    );

    expect(result.guided).toBe(false);
    expect(pushed).toHaveLength(0);
  });
});

/** 他人の分身へ書き込めないこと（SPEC 14.1） */
describe('持ち主', () => {
  it('他人の返信で自分の分身に記憶が入らない', async () => {
    const owner = await createUser(prisma);
    const other = await createUser(prisma);
    await createPersona(prisma, owner.id);

    const result = await recordLineReplyForUser(
      { userId: other.id, text: '先月から使ってみました', eventId: 'ev-1' },
      deps(),
    );

    // 他人の分身は数に入らないので「分身が無い」になる
    expect(result.outcome).toBe('NO_PERSONA');
    expect(await listPersonaFactsForUser(owner.id)).toHaveLength(0);
  });
});

/** 受け口そのものの検証は `verifyLineSignature`（単体試験）で見ている */
describe('署名', () => {
  it('本文から作った署名で通る', () => {
    const body = JSON.stringify({ events: [] });

    expect(
      verifyLineSignature({
        body,
        signature: createHmac('sha256', CHANNEL_SECRET)
          .update(body)
          .digest('base64'),
        channelSecret: CHANNEL_SECRET,
      }),
    ).toBe(true);
  });
});
