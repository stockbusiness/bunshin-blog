import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { LINE_ISSUER, authenticateWithLiff } from '@/modules/auth';
import { listAuditLogsForAdmin } from '@/modules/audit';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * LIFFログインの記録を**実PostgreSQLで**確かめる（TASKS H-13、SPEC 14.4）。
 *
 * **fake では確かめられないこと**をここで見る。
 *
 * - 実際に `audit_logs` の行になること
 * - **`line_user_id` が行のどこにも入らないこと**（SPEC 14.2）
 *
 * `line_user_id` は身元そのもので、`AppUser` にすら載せていない。
 * 監査ログは ADMIN が読む場所なので、ここへ漏れると意味が無くなる。
 */

const CHANNEL_ID = '1234567890';
const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-12T00:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const LINE_USER_ID = 'U-line-user-id-should-not-appear';

let prisma: PrismaClient;

function stubFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        iss: LINE_ISSUER,
        sub: LINE_USER_ID,
        aud: CHANNEL_ID,
        exp: NOW_SECONDS + 3600,
        iat: NOW_SECONDS - 60,
        name: 'テストモニター',
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function login() {
  return authenticateWithLiff('id.token', {
    channelId: CHANNEL_ID,
    fetchImpl: stubFetch(),
    secret: SECRET,
    now: () => NOW,
  });
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

describe('ログインの記録', () => {
  it('初回のログインが残る', async () => {
    const { user } = await login();

    const logs = await listAuditLogsForAdmin({ entityType: 'user' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUserId: user.id,
      action: 'USER_LOGGED_IN',
      entityId: user.id,
    });
    // 初回かどうかは、後から参加の流れを追うのに要る
    expect(logs[0]?.metadata).toMatchObject({ method: 'LIFF', created: true });
  });

  it('2回目は created が false', async () => {
    await login();
    await login();

    const logs = await listAuditLogsForAdmin({ entityType: 'user' });

    expect(logs).toHaveLength(2);
    expect(logs[0]?.metadata).toMatchObject({ created: false });
  });

  /**
   * **ここがこの試験の中心。** `line_user_id` は身元そのもので、
   * `AppUser` にすら載せていない（SPEC 14.2）
   */
  it('line_user_id を行のどこにも入れない', async () => {
    await login();

    const rows = await prisma.auditLog.findMany();

    expect(JSON.stringify(rows)).not.toContain(LINE_USER_ID);
  });

  /** 表示名も入れない。**内部IDから引ける** */
  it('表示名を入れない', async () => {
    await login();

    const rows = await prisma.auditLog.findMany();

    expect(JSON.stringify(rows)).not.toContain('テストモニター');
  });
});
