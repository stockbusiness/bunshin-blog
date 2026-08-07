import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import {
  closeBlogForUser,
  createBlogForUser,
  findBlogForUser,
  listBlogsForUser,
  requireBlogForUser,
  updateBlogForUser,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 所有権検証を**実PostgreSQLで**検証する（TASKS B-3）。
 *
 * 完了条件「自分のブログのみ取得・更新できる」。
 * fake DB では SQL の条件そのものを検証できないため、実DBで確認する。
 *
 * なお **2ユーザー×2ブログの越境シナリオ全体は C-6** の範囲。
 * ここでは B-3 が作った blogs モジュールの範囲に限る。
 */

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let ownerBlogId: string;
let otherBlogId: string;

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  owner = await createUser(prisma, { displayName: '所有者' });
  other = await createUser(prisma, { displayName: '別ユーザー' });

  const ownerBlog = await createBlogForUser(owner.id, {
    name: '自分のブログ',
    slug: 'mine',
    targetReader: '読者',
    slotNumber: 1,
  });
  const otherBlog = await createBlogForUser(other.id, {
    name: '他人のブログ',
    slug: 'theirs',
    targetReader: '読者',
    slotNumber: 1,
  });

  ownerBlogId = ownerBlog.id;
  otherBlogId = otherBlog.id;
});

describe('取得', () => {
  it('自分のブログは取得できる', async () => {
    const blog = await requireBlogForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(blog.name).toBe('自分のブログ');
  });

  // B-3 完了条件
  it('他人のブログは取得できない', async () => {
    expect(
      await findBlogForUser({ userId: owner.id, blogId: otherBlogId }),
    ).toBe(null);
  });

  // 403 だと「そのIDは存在する」と伝わってしまう
  it('他人のブログは 404 になる。403 ではない', async () => {
    const error = await requireBlogForUser({
      userId: owner.id,
      blogId: otherBlogId,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as AppError,
    );

    expect(error?.status).toBe(404);
  });

  it('存在しないIDと他人のIDで応答が変わらない', async () => {
    const missing = await requireBlogForUser({
      userId: owner.id,
      blogId: '00000000-0000-0000-0000-000000000000',
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as AppError,
    );
    const foreign = await requireBlogForUser({
      userId: owner.id,
      blogId: otherBlogId,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as AppError,
    );

    expect(missing?.status).toBe(foreign?.status);
    expect(missing?.code).toBe(foreign?.code);
    expect(missing?.message).toBe(foreign?.message);
  });

  it('一覧に他人のブログが混ざらない', async () => {
    const blogs = await listBlogsForUser(owner.id);

    expect(blogs).toHaveLength(1);
    expect(blogs[0]?.id).toBe(ownerBlogId);
  });
});

describe('更新', () => {
  it('自分のブログは更新できる', async () => {
    const updated = await updateBlogForUser(
      { userId: owner.id, blogId: ownerBlogId },
      { name: '改名後' },
    );

    expect(updated.name).toBe('改名後');
  });

  // B-3 完了条件
  it('他人のブログは更新できない', async () => {
    await expect(
      updateBlogForUser(
        { userId: owner.id, blogId: otherBlogId },
        { name: '乗っ取り' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('拒否された更新がDBに反映されていない', async () => {
    await updateBlogForUser(
      { userId: owner.id, blogId: otherBlogId },
      { name: '乗っ取り' },
    ).catch(() => undefined);

    const record = await prisma.blog.findUnique({
      where: { id: otherBlogId },
    });

    expect(record?.name).toBe('他人のブログ');
  });
});

describe('削除', () => {
  it('自分のブログはCLOSEDになる。物理削除しない', async () => {
    const closed = await closeBlogForUser({
      userId: owner.id,
      blogId: ownerBlogId,
    });

    expect(closed.status).toBe('CLOSED');
    expect(await prisma.blog.count({ where: { id: ownerBlogId } })).toBe(1);
  });

  it('CLOSED は一覧に出ない', async () => {
    await closeBlogForUser({ userId: owner.id, blogId: ownerBlogId });

    expect(await listBlogsForUser(owner.id)).toHaveLength(0);
    expect(
      await listBlogsForUser(owner.id, { includeClosed: true }),
    ).toHaveLength(1);
  });

  it('他人のブログは削除できない', async () => {
    await expect(
      closeBlogForUser({ userId: owner.id, blogId: otherBlogId }),
    ).rejects.toMatchObject({ status: 404 });

    const record = await prisma.blog.findUnique({ where: { id: otherBlogId } });
    expect(record?.status).not.toBe('CLOSED');
  });
});

describe('作成', () => {
  it('作ったブログは自分のものになる', async () => {
    const blog = await createBlogForUser(owner.id, {
      name: '2つ目',
      slug: 'second',
      targetReader: '読者',
      slotNumber: 2,
    });

    expect(blog.userId).toBe(owner.id);
  });

  // UNIQUE(user_id, slot_number)。4件目の拒否そのものは B-4
  it('同じスロットの重複は409になる', async () => {
    await expect(
      createBlogForUser(owner.id, {
        name: '重複',
        slug: 'dup',
        targetReader: '読者',
        slotNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('別ユーザーなら同じスロット番号を使える', async () => {
    const blogs = await listBlogsForUser(other.id);

    expect(blogs[0]?.slotNumber).toBe(1);
  });
});
