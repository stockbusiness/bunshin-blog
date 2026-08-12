import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listAuditLogsForAdmin } from '@/modules/audit';
import {
  WITHDRAWAL_ERROR_CODES,
  exportUserDataForAdmin,
  updateMonitorStatusForAdmin,
  withdrawMonitorForAdmin,
} from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createPersona, createUser } from './helpers/factories';

/**
 * 退会とデータの持ち出しを**実PostgreSQLで**確かめる（TASKS H-4、SPEC 13.2）。
 *
 * 完了条件は「**物理削除せずCLOSED。データエクスポートができる**」。
 *
 * **消さないことを確かめる。** Phase 0 は10名がどこまで続いたかを見る実験で、
 * 抜けた人の記録を消すと「10名中何名が続いたか」が数えられなくなる。
 */

let prisma: PrismaClient;
let userId: string;
let adminId: string;
let blogId: string;

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
  const blog = await createBlog(prisma, userId, { name: '節約ブログ' });
  blogId = blog.id;

  const admin = await createUser(prisma);
  adminId = admin.id;
  await prisma.user.update({
    where: { id: adminId },
    data: { role: 'ADMIN', status: 'ACTIVE' },
  });
});

describe('物理削除しない（完了条件）', () => {
  it('退会しても利用者の行が残る', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, displayName: true },
    });

    expect(user).not.toBeNull();
    expect(user?.status).toBe('WITHDRAWN');
  });

  it('ブログは CLOSED になり、行は残る', async () => {
    const result = await withdrawMonitorForAdmin({
      userId,
      actorUserId: adminId,
    });

    expect(result.closedBlogs).toBe(1);

    const blog = await prisma.blog.findUnique({
      where: { id: blogId },
      select: { status: true },
    });

    expect(blog?.status).toBe('CLOSED');
  });

  /** **スロットは戻さない**（Q-008）。何枠使ったかが分からなくなる */
  it('スロット番号は残る', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    const blog = await prisma.blog.findUnique({
      where: { id: blogId },
      select: { slotNumber: true },
    });

    expect(blog?.slotNumber).toBe(1);
  });

  it('二度呼んでも成功する（冪等）', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    const second = await withdrawMonitorForAdmin({
      userId,
      actorUserId: adminId,
    });

    expect(second.user.status).toBe('WITHDRAWN');
    expect(second.closedBlogs).toBe(0);
  });

  /** **退会は戻せない**（H-1 の遷移表） */
  it('退会したら承認で戻せない', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    await expect(
      updateMonitorStatusForAdmin({
        userId,
        action: 'ACTIVATE',
        actorUserId: adminId,
      }),
    ).rejects.toThrow();
  });

  it('ADMIN は退会させられない', async () => {
    await expect(
      withdrawMonitorForAdmin({ userId: adminId, actorUserId: adminId }),
    ).rejects.toMatchObject({ code: WITHDRAWAL_ERROR_CODES.notFound });
  });
});

describe('記録が残る（H-11）', () => {
  it('退会が監査ログに残る', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    const logs = await listAuditLogsForAdmin({ entityId: userId });

    expect(logs[0]).toMatchObject({
      action: 'MONITOR_WITHDRAWN',
      actorUserId: adminId,
    });
    expect(logs[0]?.metadata).toMatchObject({ closedBlogs: 1 });
  });
});

describe('データエクスポート（完了条件）', () => {
  it('利用者とブログが入る', async () => {
    const data = await exportUserDataForAdmin(userId);

    expect(data.user.id).toBe(userId);
    expect(data.blogs).toHaveLength(1);
    expect(data.blogs[0]?.name).toBe('節約ブログ');
  });

  /**
   * **分身も持ち出せる**（A-2-R-2f）。1ユーザー1件だった頃は1つの
   * オブジェクトだったが、複数持てるようになったので配列で返す。
   *
   * `ARCHIVED` も含める — **途中でやめた分身があること自体が本人の記録**で、
   * 抜くと「最初から作らなかった」と区別できない。
   */
  it('分身が入る（やめたものも含む）', async () => {
    const archived = await createPersona(prisma, userId, {
      name: 'やめた分身',
    });
    await prisma.persona.update({
      where: { id: archived.id },
      data: { status: 'ARCHIVED' },
    });

    const data = await exportUserDataForAdmin(userId);

    // ブログと一緒に作られた分身（`createBlog`）と、やめた分身の2件
    expect(data.personas).toHaveLength(2);
    expect(data.personas.map((persona) => persona.name)).toContain(
      'やめた分身',
    );
    expect(
      data.personas.find((persona) => persona.name === 'やめた分身')?.status,
    ).toBe('ARCHIVED');
  });

  /** **閉じたブログも含める。** 外すと退会後に空のファイルが出てくる */
  it('退会後も中身が入っている', async () => {
    await withdrawMonitorForAdmin({ userId, actorUserId: adminId });

    const data = await exportUserDataForAdmin(userId);

    expect(data.blogs).toHaveLength(1);
    expect(data.blogs[0]?.status).toBe('CLOSED');
  });

  it('記事の本文まで入る', async () => {
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
      },
      select: { id: true },
    });
    await prisma.articleVersion.create({
      data: {
        contentItemId: item.id,
        versionNo: 1,
        title: '記事のタイトル',
        excerpt: '要約',
        answerCapsule: '結論',
        bodyHtml: '<p>持ち出したい本文</p>',
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
    });

    const data = await exportUserDataForAdmin(userId);
    const articles = data.blogs[0]?.articles ?? [];

    expect(articles).toHaveLength(1);
    expect(articles[0]?.versions[0]?.bodyHtml).toBe('<p>持ち出したい本文</p>');
  });

  /** **秘密は含めない**（SPEC 14.2） */
  it('WordPress の認証情報が入らない', async () => {
    await prisma.wordpressConnection.create({
      data: {
        blogId,
        siteUrl: 'https://example.com',
        apiBaseUrl: 'https://example.com/wp-json',
        wpUsernameEncrypted: 'ENCRYPTED-USERNAME-VALUE',
        appPasswordEncrypted: 'ENCRYPTED-SECRET-VALUE',
        connectionStatus: 'CONNECTED',
      },
    });

    const dumped = JSON.stringify(await exportUserDataForAdmin(userId));

    expect(dumped).not.toContain('ENCRYPTED-SECRET-VALUE');
    expect(dumped).not.toContain('appPassword');
  });

  /** **`line_user_id` も入れない**（F-2 と同じ扱い） */
  it('LINEのユーザーIDが入らない', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lineUserId: true },
    });

    const dumped = JSON.stringify(await exportUserDataForAdmin(userId));

    expect(dumped).not.toContain(user.lineUserId ?? '@@none@@');
  });

  it('他人のデータは混ざらない', async () => {
    const other = await createUser(prisma);
    await createBlog(prisma, other.id, { name: '他人のブログ' });

    const dumped = JSON.stringify(await exportUserDataForAdmin(userId));

    expect(dumped).not.toContain('他人のブログ');
  });

  it('居ないIDは 404', async () => {
    await expect(
      exportUserDataForAdmin('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: WITHDRAWAL_ERROR_CODES.notFound });
  });

  it('取り出した時刻が入る', async () => {
    const data = await exportUserDataForAdmin(
      userId,
      new Date('2026-08-10T00:00:00.000Z'),
    );

    expect(data.exportedAt).toBe('2026-08-10T00:00:00.000Z');
  });
});
