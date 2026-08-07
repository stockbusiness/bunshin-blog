import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import type { Mailer } from '@/lib/mailer';
import {
  consumeAdminLoginLink,
  hashLoginToken,
  requestAdminLoginLink,
  verifySessionToken,
} from '@/modules/auth';
import { findAdminByEmail } from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * 管理者のログインリンクを**実PostgreSQLで**検証する（TASKS B-11）。
 *
 * ユニットテスト（`src/tests/modules/auth/admin-login.test.ts`）は
 * 差し替えた置き場で分岐を固めている。ここで確かめるのは、**fake では
 * 証明にならない2点**。
 *
 * - `WHERE used_at IS NULL` の1文更新が、同時に叩かれても片方だけ通すこと
 * - メールアドレスの照合が `role = 'ADMIN'` の行だけを拾うこと
 */

const SECRET = 'a'.repeat(48);
const BASE_URL = 'https://example.test';

let prisma: PrismaClient;

function collectingMailer() {
  const sent: string[] = [];
  const mailer: Mailer = {
    send: async (message) => {
      sent.push(message.text);
    },
  };
  return { mailer, sent };
}

/** 送られた本文からトークンを取り出す */
function tokenFrom(text: string): string {
  return /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
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
});

async function createAdmin(email: string, status = 'ACTIVE') {
  return prisma.user.create({
    data: {
      role: 'ADMIN',
      displayName: '運営',
      email,
      status: status as 'ACTIVE',
    },
  });
}

async function issueFor(email: string) {
  const { mailer, sent } = collectingMailer();

  const result = await requestAdminLoginLink(email, {
    mailer,
    baseUrl: BASE_URL,
  });

  return { result, token: tokenFrom(sent[0] ?? ''), sent };
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as AppError,
  );
}

describe('メールアドレスの照合', () => {
  it('ADMIN のアドレスならリンクを送る', async () => {
    await createAdmin('admin@example.test');

    const { result, sent } = await issueFor('admin@example.test');

    expect(result.outcome).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('**MONITOR のアドレスには送らない**', async () => {
    await prisma.user.create({
      data: {
        role: 'MONITOR',
        displayName: 'モニター',
        email: 'monitor@example.test',
        status: 'ACTIVE',
      },
    });

    const { result, sent } = await issueFor('monitor@example.test');

    expect(result.outcome).toBe('unknown-email');
    expect(sent).toHaveLength(0);
    expect(await prisma.adminLoginToken.count()).toBe(0);
  });

  it('未登録のアドレスには送らない', async () => {
    const { result, sent } = await issueFor('nobody@example.test');

    expect(result.outcome).toBe('unknown-email');
    expect(sent).toHaveLength(0);
  });

  it('大文字small差を吸収する', async () => {
    await createAdmin('admin@example.test');

    expect(await findAdminByEmail('ADMIN@Example.Test')).not.toBeNull();
  });

  it('停止中の管理者には送らない', async () => {
    await createAdmin('paused@example.test', 'PAUSED');

    const { result, sent } = await issueFor('paused@example.test');

    expect(result.outcome).toBe('not-active');
    expect(sent).toHaveLength(0);
  });
});

describe('保存されるもの', () => {
  it('**トークンの原文はDBに残らない**', async () => {
    await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');

    const rows = await prisma.adminLoginToken.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashLoginToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('期限が未来に設定される', async () => {
    await createAdmin('admin@example.test');
    await issueFor('admin@example.test');

    const row = await prisma.adminLoginToken.findFirst();

    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row?.usedAt).toBeNull();
  });
});

describe('リンクは1回だけ使える', () => {
  it('1回目は通り、セッションが発行される', async () => {
    const admin = await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');

    const result = await consumeAdminLoginLink(token, { secret: SECRET });

    expect(result.user.id).toBe(admin.id);
    expect(
      verifySessionToken(result.sessionToken, { secret: SECRET })?.userId,
    ).toBe(admin.id);
  });

  it('2回目は 401', async () => {
    await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');

    await consumeAdminLoginLink(token, { secret: SECRET });
    const error = await catchError(
      consumeAdminLoginLink(token, { secret: SECRET }),
    );

    expect(error.status).toBe(401);
  });

  it('**同時に叩かれても片方だけが通る**', async () => {
    await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');

    const results = await Promise.allSettled([
      consumeAdminLoginLink(token, { secret: SECRET }),
      consumeAdminLoginLink(token, { secret: SECRET }),
      consumeAdminLoginLink(token, { secret: SECRET }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    const row = await prisma.adminLoginToken.findFirst();
    expect(row?.usedAt).not.toBeNull();
  });

  it('期限切れは使えない', async () => {
    await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');

    const later = new Date(Date.now() + 30 * 60 * 1000);
    const error = await catchError(
      consumeAdminLoginLink(token, { secret: SECRET, now: () => later }),
    );

    expect(error.status).toBe(401);

    // 期限切れは使用済みにしない
    const row = await prisma.adminLoginToken.findFirst();
    expect(row?.usedAt).toBeNull();
  });

  it('**期限切れ・使用済み・未登録で応答が変わらない**（完了条件）', async () => {
    await createAdmin('admin@example.test');
    const { token } = await issueFor('admin@example.test');
    await consumeAdminLoginLink(token, { secret: SECRET });

    const used = await catchError(
      consumeAdminLoginLink(token, { secret: SECRET }),
    );
    const unknown = await catchError(
      consumeAdminLoginLink('never-issued-token', { secret: SECRET }),
    );

    const { token: freshToken } = await issueFor('admin@example.test');
    const later = new Date(Date.now() + 30 * 60 * 1000);
    const expired = await catchError(
      consumeAdminLoginLink(freshToken, { secret: SECRET, now: () => later }),
    );

    for (const error of [unknown, expired]) {
      expect(error.status).toBe(used.status);
      expect(error.code).toBe(used.code);
      expect(error.message).toBe(used.message);
      expect(error.details).toBeUndefined();
    }
  });
});

describe('発行数の制限', () => {
  it('続けて発行しすぎると送らない', async () => {
    await createAdmin('admin@example.test');
    const { mailer, sent } = collectingMailer();
    const options = { mailer, baseUrl: BASE_URL };

    for (let index = 0; index < 4; index += 1) {
      await requestAdminLoginLink('admin@example.test', options);
    }

    expect(sent).toHaveLength(3);
    expect(await prisma.adminLoginToken.count()).toBe(3);
  });
});
