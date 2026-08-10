import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listAuditLogsForAdmin, recordAudit } from '@/modules/audit';
import { updateMonitorStatusForAdmin } from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 監査ログを**実PostgreSQLで**確かめる（TASKS H-11、SPEC 5.20、Q-018）。
 *
 * 完了条件は「**ADMINの介入と「承知で進める」の選択が記録される**」。
 *
 * 「承知で進める」（E-4）はジャンル審査の統合テストで押さえる。
 * ここでは ADMIN の介入と、記録そのものの性質を確かめる。
 */

let prisma: PrismaClient;
let userId: string;
let adminId: string;

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

describe('ADMINの介入が記録される（完了条件）', () => {
  it('承認が残る', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
    });

    const logs = await listAuditLogsForAdmin({
      entityType: 'user',
      entityId: userId,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'MONITOR_ACTIVATED',
      actorUserId: adminId,
      entityType: 'user',
      entityId: userId,
    });
  });

  it('どこからどこへ動いたかを残す', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
    });

    const [log] = await listAuditLogsForAdmin({ entityId: userId });

    expect(log?.metadata).toEqual({ from: 'INVITED', to: 'ACTIVE' });
  });

  it('停止と再開も残る', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
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
    });

    const logs = await listAuditLogsForAdmin({ entityId: userId });

    // 新しい順
    expect(logs.map((log) => log.action)).toEqual([
      'MONITOR_RESUMED',
      'MONITOR_PAUSED',
      'MONITOR_ACTIVATED',
    ]);
  });

  /** **介入と記録は同時に決まる。** 片方だけ残らない */
  it('遷移できなければ記録も残らない', async () => {
    await expect(
      updateMonitorStatusForAdmin({
        userId,
        action: 'RESUME',
        actorUserId: adminId,
      }),
    ).rejects.toThrow();

    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe('秘密を残さない（SPEC 14.2）', () => {
  /** **氏名や `line_user_id` を入れない。** どこからどこへだけを残す */
  it('metadata に本人を特定する値を入れない', async () => {
    await updateMonitorStatusForAdmin({
      userId,
      action: 'ACTIVATE',
      actorUserId: adminId,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lineUserId: true, displayName: true },
    });

    const [log] = await listAuditLogsForAdmin({ entityId: userId });
    const dumped = JSON.stringify(log?.metadata);

    expect(dumped).not.toContain(user.lineUserId ?? '@@none@@');
    expect(dumped).not.toContain(user.displayName);
  });
});

describe('記録の失敗で本体を止めない', () => {
  /**
   * **後から辿るためのもので、書けないことを理由に操作を失敗させない。**
   * 存在しない利用者を行為者にすると外部キーで落ちる
   */
  it('書けなくても投げない', async () => {
    await expect(
      recordAudit({
        actorUserId: '00000000-0000-4000-8000-000000000000',
        action: 'MONITOR_ACTIVATED',
        entityType: 'user',
        entityId: userId,
      }),
    ).resolves.toBeUndefined();

    expect(await prisma.auditLog.count()).toBe(0);
  });

  /** システムが自動で行った記録は行為者が `null`（SPEC 5.20） */
  it('行為者が null でも書ける', async () => {
    await recordAudit({
      actorUserId: null,
      action: 'BLOG_SITE_URL_CHANGED',
      entityType: 'blog',
      entityId: null,
      metadata: { reason: 'test' },
    });

    const logs = await listAuditLogsForAdmin({});

    expect(logs).toHaveLength(1);
    expect(logs[0]?.actorUserId).toBeNull();
  });
});

describe('一覧', () => {
  it('対象で絞れる', async () => {
    await recordAudit({
      actorUserId: adminId,
      action: 'MONITOR_ACTIVATED',
      entityType: 'user',
      entityId: userId,
    });
    await recordAudit({
      actorUserId: adminId,
      action: 'BLOG_SITE_URL_CHANGED',
      entityType: 'blog',
      entityId: null,
    });

    expect(await listAuditLogsForAdmin({ entityType: 'user' })).toHaveLength(1);
    expect(await listAuditLogsForAdmin({})).toHaveLength(2);
  });

  /** 際限なく返さない */
  it('件数に上限がある', async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordAudit({
        actorUserId: adminId,
        action: 'MONITOR_ACTIVATED',
        entityType: 'user',
        entityId: userId,
      });
    }

    expect(await listAuditLogsForAdmin({ limit: 2 })).toHaveLength(2);
    expect(await listAuditLogsForAdmin({ limit: 0 })).toHaveLength(1);
  });
});
