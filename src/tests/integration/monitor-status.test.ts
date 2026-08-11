import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { requireConsentedUser } from '@/modules/auth';
import { createSessionToken } from '@/modules/auth';
import {
  USER_ADMIN_ERROR_CODES,
  updateMonitorStatusForAdmin,
} from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * モニターの状態変更を**実PostgreSQLで**確かめる（TASKS H-1、SPEC 6.2）。
 *
 * 完了条件は「**招待〜ACTIVE化が管理画面で完結**」。
 *
 * 実験への参加は「登録できた」ではなく「**ADMIN が認めた**」で決まる。
 * `INVITED` のままアプリを使えないことも、ここで併せて確かめる。
 */

let prisma: PrismaClient;
let userId: string;
let adminId: string;

/** 操作するADMINを必ず伴う（H-11） */
async function act(action: 'ACTIVATE' | 'PAUSE' | 'RESUME') {
  return updateMonitorStatusForAdmin({ userId, action, actorUserId: adminId });
}

async function activate() {
  return act('ACTIVATE');
}

async function statusOf(id: string): Promise<string | undefined> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { status: true },
  });

  return user?.status;
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
  await prisma.user.update({
    where: { id: userId },
    data: { status: 'INVITED' },
  });

  const admin = await createUser(prisma);
  adminId = admin.id;
  await prisma.user.update({
    where: { id: adminId },
    data: { role: 'ADMIN', status: 'ACTIVE' },
  });
});

describe('招待から利用開始まで（完了条件）', () => {
  it('承認すると ACTIVE になる', async () => {
    const user = await activate();

    expect(user.status).toBe('ACTIVE');
    expect(await statusOf(userId)).toBe('ACTIVE');
  });

  /** **管理画面は複数人が開きうる。** 二度押しで落とさない */
  it('二度承認しても成功する（冪等）', async () => {
    await activate();

    await expect(activate()).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  /** **承認されるまでアプリを使えない** */
  it('INVITED のままでは API を通れない', async () => {
    const token = createSessionToken(userId);

    await expect(
      requireConsentedUser(`bunshin_session=${token}`),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('承認し、同意が揃えば通れる', async () => {
    await activate();
    await prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), dataUseConsentAt: new Date() },
    });

    const token = createSessionToken(userId);

    await expect(
      requireConsentedUser(`bunshin_session=${token}`),
    ).resolves.toMatchObject({ id: userId });
  });
});

describe('利用停止と再開（SPEC 6.2）', () => {
  beforeEach(async () => {
    await activate();
  });

  it('停止すると PAUSED になる', async () => {
    await act('PAUSE');

    expect(await statusOf(userId)).toBe('PAUSED');
  });

  /** **停止したら古いCookieでも通れない**（B-6 の毎回DBを見る設計） */
  it('停止すると API を通れなくなる', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), dataUseConsentAt: new Date() },
    });
    const token = createSessionToken(userId);

    await expect(
      requireConsentedUser(`bunshin_session=${token}`),
    ).resolves.toMatchObject({ id: userId });

    await act('PAUSE');

    await expect(
      requireConsentedUser(`bunshin_session=${token}`),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('再開すると ACTIVE に戻る', async () => {
    await act('PAUSE');
    await act('RESUME');

    expect(await statusOf(userId)).toBe('ACTIVE');
  });
});

describe('変えられない遷移', () => {
  /** **認めるのは `ACTIVATE` だけ。** 停止の解除で参加を認めない */
  it('INVITED を RESUME できない', async () => {
    await expect(act('RESUME')).rejects.toMatchObject({
      code: USER_ADMIN_ERROR_CODES.invalidTransition,
      status: 409,
    });

    expect(await statusOf(userId)).toBe('INVITED');
  });

  it('INVITED を PAUSE できない', async () => {
    await expect(act('PAUSE')).rejects.toMatchObject({
      code: USER_ADMIN_ERROR_CODES.invalidTransition,
    });
  });

  /** **退会は戻せない**（H-4 が扱う） */
  it('WITHDRAWN は動かせない', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'WITHDRAWN' },
    });

    for (const action of ['ACTIVATE', 'PAUSE', 'RESUME'] as const) {
      await expect(act(action)).rejects.toMatchObject({
        code: USER_ADMIN_ERROR_CODES.invalidTransition,
      });
    }

    expect(await statusOf(userId)).toBe('WITHDRAWN');
  });
});

describe('ADMIN は対象にしない', () => {
  /** **ADMIN 同士で停止し合えると、誰も管理画面に入れなくなる** */
  it('ADMIN の状態は変えられない', async () => {
    const admin = await createUser(prisma);
    await prisma.user.update({
      where: { id: admin.id },
      data: { role: 'ADMIN', status: 'ACTIVE' },
    });

    await expect(
      updateMonitorStatusForAdmin({
        userId: admin.id,
        action: 'PAUSE',
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ code: USER_ADMIN_ERROR_CODES.notFound });

    expect(await statusOf(admin.id)).toBe('ACTIVE');
  });

  it('居ないIDは 404', async () => {
    await expect(
      updateMonitorStatusForAdmin({
        userId: '00000000-0000-4000-8000-000000000000',
        action: 'ACTIVATE',
        actorUserId: adminId,
      }),
    ).rejects.toMatchObject({ code: USER_ADMIN_ERROR_CODES.notFound });
  });
});

/**
 * **参加開始日は最初に認めた1回だけ**（Q-034、ROADMAP 5章）。
 *
 * ここを起点に、分身の段階解放・90日検証の期間・8週間継続率の3つを数える。
 * 停止して再開するたびに動くと、**3つとも数え方が変わる。**
 */
describe('参加開始日', () => {
  const FIRST = new Date('2026-08-01T00:00:00.000Z');
  const LATER = new Date('2026-09-01T00:00:00.000Z');

  async function activatedAtOf(): Promise<Date | null | undefined> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { activatedAt: true },
    });

    return user?.activatedAt;
  }

  it('登録しただけでは入らない', async () => {
    expect(await activatedAtOf()).toBeNull();
  });

  it('ADMINが認めた時刻が入る', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
      now: FIRST,
    });

    expect(await activatedAtOf()).toEqual(FIRST);
  });

  it('二度目の承認では動かない', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
      now: FIRST,
    });
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
      now: LATER,
    });

    expect(await activatedAtOf()).toEqual(FIRST);
  });

  /** **停止して再開しても起点は最初のまま** */
  it('停止・再開で動かない', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
      now: FIRST,
    });
    await updateMonitorStatusForAdmin({
      userId,
      action: 'PAUSE',
      actorUserId: adminId,
    });
    await updateMonitorStatusForAdmin({
      userId,
      action: 'RESUME',
      actorUserId: adminId,
      now: LATER,
    });

    expect(await activatedAtOf()).toEqual(FIRST);
  });
});
