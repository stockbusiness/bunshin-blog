import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * `admin_login_tokens` の構造を**実PostgreSQLで**検証する（TASKS B-10）。
 *
 * 完了条件「`migrate deploy` が成功し、スキーマとの乖離が無い。
 * トークンのハッシュ・期限・使用時刻を保持できる」。
 *
 * **B-10 はテーブルだけ。** 発行・検証の実装は B-11。ここで確かめるのは
 * 「DBが期待どおり守ってくれるか」であり、アプリ側の判定ではない。
 */

let prisma: PrismaClient;
let adminId: string;

const FIFTEEN_MINUTES = 15 * 60 * 1000;

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const admin = await prisma.user.create({
    data: {
      role: 'ADMIN',
      displayName: '運営',
      email: 'admin@example.com',
      status: 'ACTIVE',
    },
  });
  adminId = admin.id;
});

function future(ms = FIFTEEN_MINUTES): Date {
  return new Date(Date.now() + ms);
}

async function issue(tokenHash: string, expiresAt = future()) {
  return prisma.adminLoginToken.create({
    data: { userId: adminId, tokenHash, expiresAt },
  });
}

describe('保持できる項目', () => {
  it('ハッシュ・期限・発行時刻を保存する', async () => {
    const token = await issue('hash-1');

    expect(token.tokenHash).toBe('hash-1');
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(token.createdAt).toBeInstanceOf(Date);
  });

  it('使用時刻は既定で null', async () => {
    const token = await issue('hash-2');

    expect(token.usedAt).toBeNull();
  });

  it('使用時刻を記録できる（1回だけ使うための土台）', async () => {
    const token = await issue('hash-3');
    const used = await prisma.adminLoginToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });

    expect(used.usedAt).not.toBeNull();
  });

  it('同じユーザーに複数のトークンを持てる（再送のため）', async () => {
    await issue('hash-a');
    await issue('hash-b');

    expect(
      await prisma.adminLoginToken.count({ where: { userId: adminId } }),
    ).toBe(2);
  });
});

describe('DB側の制約', () => {
  it('ハッシュは重複できない', async () => {
    await issue('same-hash');

    await expect(issue('same-hash')).rejects.toThrow();
  });

  it('期限が発行より前のトークンを作れない', async () => {
    await expect(
      issue('already-expired', new Date(Date.now() - 60_000)),
    ).rejects.toThrow();
  });

  it('使用時刻を発行より前にできない', async () => {
    const token = await issue('hash-used');

    await expect(
      prisma.adminLoginToken.update({
        where: { id: token.id },
        data: { usedAt: new Date(token.createdAt.getTime() - 1000) },
      }),
    ).rejects.toThrow();
  });

  it('存在しないユーザーには発行できない', async () => {
    await expect(
      prisma.adminLoginToken.create({
        data: {
          userId: '00000000-0000-0000-0000-0000000000ff',
          tokenHash: 'orphan',
          expiresAt: future(),
        },
      }),
    ).rejects.toThrow();
  });

  it('ユーザーを消すとトークンも消える', async () => {
    await issue('hash-cascade');
    await prisma.user.delete({ where: { id: adminId } });

    expect(await prisma.adminLoginToken.count()).toBe(0);
  });
});

describe('B-11 が使う引き方', () => {
  it('ハッシュから1件引ける', async () => {
    await issue('lookup-me');

    const found = await prisma.adminLoginToken.findUnique({
      where: { tokenHash: 'lookup-me' },
    });

    expect(found?.userId).toBe(adminId);
  });

  it('未使用かつ期限内のものだけを選べる', async () => {
    const valid = await issue('valid');
    const used = await issue('used');
    await prisma.adminLoginToken.update({
      where: { id: used.id },
      data: { usedAt: new Date() },
    });

    const usable = await prisma.adminLoginToken.findMany({
      where: { usedAt: null, expiresAt: { gt: new Date() } },
    });

    expect(usable.map((token) => token.id)).toEqual([valid.id]);
  });

  it('直近の発行数を数えられる（連続発行の制限に使う）', async () => {
    await issue('recent-1');
    await issue('recent-2');

    const since = new Date(Date.now() - 60_000);
    const count = await prisma.adminLoginToken.count({
      where: { userId: adminId, createdAt: { gte: since } },
    });

    expect(count).toBe(2);
  });
});
