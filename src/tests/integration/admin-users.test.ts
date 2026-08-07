import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  EMPTY_BLOG_COUNT,
  countBlogsByUserForAdmin,
  createBlogForUser,
  closeBlogForUser,
} from '@/modules/blogs';
import { listMonitorsForAdmin } from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 管理画面のモニター一覧を**実PostgreSQLで**検証する（TASKS B-7）。
 *
 * 完了条件「モニター一覧とオンボーディング状況が表示される」。
 *
 * ここは**全ユーザーを横断して読む唯一の経路**（MODULE_RULES 5）。
 * 誰が含まれ、誰が含まれないかを実DBで固定する。
 */

let prisma: PrismaClient;

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

/** `monitor_profiles` を作る。オンボーディング状況はここに入る */
async function createProfile(
  userId: string,
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED',
): Promise<void> {
  await prisma.monitorProfile.create({
    data: {
      userId,
      primaryAspNames: [],
      notificationDays: [1],
      notificationTime: new Date('1970-01-01T09:00:00Z'),
      onboardingStatus,
    },
  });
}

describe('listMonitorsForAdmin', () => {
  it('モニターが居なければ空', async () => {
    expect(await listMonitorsForAdmin()).toEqual([]);
  });

  it('登録順に並ぶ', async () => {
    const first = await createUser(prisma, { displayName: '一人目' });
    const second = await createUser(prisma, { displayName: '二人目' });

    const monitors = await listMonitorsForAdmin();

    expect(monitors.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('ADMIN を含めない（SPEC 6.2 はモニター一覧）', async () => {
    const monitor = await createUser(prisma, { displayName: 'モニター' });
    await prisma.user.create({
      data: { role: 'ADMIN', displayName: '運営', status: 'ACTIVE' },
    });

    const monitors = await listMonitorsForAdmin();

    expect(monitors.map((m) => m.id)).toEqual([monitor.id]);
  });

  it('退会者も残す。実験の継続率が読めなくなるため', async () => {
    await createUser(prisma, { displayName: '退会者', status: 'WITHDRAWN' });

    const monitors = await listMonitorsForAdmin();

    expect(monitors).toHaveLength(1);
    expect(monitors[0]?.status).toBe('WITHDRAWN');
  });

  it.each(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as const)(
    'オンボーディング状況 %s を返す',
    async (status) => {
      const user = await createUser(prisma);
      await createProfile(user.id, status);

      const monitors = await listMonitorsForAdmin();

      expect(monitors[0]?.onboardingStatus).toBe(status);
    },
  );

  it('プロフィール未作成なら null', async () => {
    await createUser(prisma);

    const monitors = await listMonitorsForAdmin();

    expect(monitors[0]?.onboardingStatus).toBeNull();
  });

  it('同意の時刻をそのまま返す', async () => {
    await createUser(prisma, { consented: false });
    await createUser(prisma, { consented: true });

    const monitors = await listMonitorsForAdmin();

    expect(monitors[0]?.termsAcceptedAt).toBeNull();
    expect(monitors[0]?.dataUseConsentAt).toBeNull();
    expect(monitors[1]?.termsAcceptedAt).not.toBeNull();
    expect(monitors[1]?.dataUseConsentAt).not.toBeNull();
  });
});

describe('countBlogsByUserForAdmin', () => {
  it('ブログが無ければ空', async () => {
    await createUser(prisma);

    expect(await countBlogsByUserForAdmin()).toEqual({});
  });

  it('ユーザーごとに数える', async () => {
    const a = await createUser(prisma);
    const b = await createUser(prisma);

    await createBlogForUser(a.id, {
      name: 'A1',
      slug: 'a1',
      targetReader: '読者',
    });
    await createBlogForUser(a.id, {
      name: 'A2',
      slug: 'a2',
      targetReader: '読者',
    });
    await createBlogForUser(b.id, {
      name: 'B1',
      slug: 'b1',
      targetReader: '読者',
    });

    const counts = await countBlogsByUserForAdmin();

    expect(counts[a.id]).toEqual({ open: 2, closed: 0, usedSlots: 2 });
    expect(counts[b.id]).toEqual({ open: 1, closed: 0, usedSlots: 1 });
  });

  it('CLOSED を分けて数え、使用枠には含める（Q-008）', async () => {
    const user = await createUser(prisma);
    const blog = await createBlogForUser(user.id, {
      name: '閉じる',
      slug: 'closing',
      targetReader: '読者',
    });
    await createBlogForUser(user.id, {
      name: '稼働',
      slug: 'running',
      targetReader: '読者',
    });
    await closeBlogForUser({ userId: user.id, blogId: blog.id });

    const counts = await countBlogsByUserForAdmin();

    // 稼働は1件だが、枠は2つ埋まっている
    expect(counts[user.id]).toEqual({ open: 1, closed: 1, usedSlots: 2 });
  });

  it('SETUP や PAUSED も稼働側で数える', async () => {
    const user = await createUser(prisma);
    const blog = await createBlogForUser(user.id, {
      name: '休止',
      slug: 'paused',
      targetReader: '読者',
    });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { status: 'PAUSED' },
    });

    const counts = await countBlogsByUserForAdmin();

    expect(counts[user.id]).toEqual({ open: 1, closed: 0, usedSlots: 1 });
  });

  it('0件のユーザーは戻り値に現れない（画面側で既定値を使う）', async () => {
    const withBlog = await createUser(prisma);
    const without = await createUser(prisma);
    await createBlogForUser(withBlog.id, {
      name: '持っている',
      slug: 'has-one',
      targetReader: '読者',
    });

    const counts = await countBlogsByUserForAdmin();

    expect(counts[without.id]).toBeUndefined();
    expect(counts[without.id] ?? EMPTY_BLOG_COUNT).toEqual({
      open: 0,
      closed: 0,
      usedSlots: 0,
    });
  });

  it('問い合わせ回数がユーザー数に比例しない', async () => {
    // 5人ぶん作っても集計は1回で済むことを、実行時間ではなく
    // 「全員分が1回の呼び出しで揃う」ことで確かめる
    const users = [];
    for (let index = 0; index < 5; index += 1) {
      const user = await createUser(prisma);
      await createBlogForUser(user.id, {
        name: `ブログ${String(index)}`,
        slug: `bulk-${String(index)}`,
        targetReader: '読者',
      });
      users.push(user);
    }

    const counts = await countBlogsByUserForAdmin();

    expect(Object.keys(counts)).toHaveLength(5);
    for (const user of users) {
      expect(counts[user.id]?.open).toBe(1);
    }
  });
});
