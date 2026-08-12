import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import {
  ARTICLE_RATIO_ERROR_CODES,
  DEFAULT_ARTICLE_RATIO,
  createBlogForUser,
  listBlogsForUser,
  requireBlogForUser,
  updateBlogForUser,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * ブログ設定の保存を**実PostgreSQLで**検証する（TASKS B-5）。
 *
 * `article_ratio` は jsonb であり、部分更新ができない。**上限だけを
 * 差し替えたつもりで算出値ごと上書きしていないか**は、実際に読み書き
 * しないと分からない（OPEN_QUESTIONS Q-011）。
 */

let prisma: PrismaClient;
let user: { id: string };
let other: { id: string };
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

  user = await createUser(prisma, { displayName: 'モニター' });
  other = await createUser(prisma, { displayName: '別モニター' });

  const blog = await createBlogForUser(user.id, {
    personaId: (await createPersona(prisma, user.id)).id,
    name: '設定テスト',
    slug: 'settings-test',
    targetReader: '30代の会社員',
  });
  blogId = blog.id;
});

/** `updateBlogForUser` が投げた `AppError` を取り出す */
async function catchError(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as AppError,
  );
}

describe('編集できる項目', () => {
  it('名前・ペンネーム・想定読者・収益方針をまとめて保存できる', async () => {
    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      {
        name: '新しい名前',
        penName: 'たろう',
        targetReader: '40代の主婦',
        purpose: 'MIXED',
      },
    );

    expect(updated).toMatchObject({
      name: '新しい名前',
      penName: 'たろう',
      targetReader: '40代の主婦',
      purpose: 'MIXED',
    });
  });

  it('ペンネームを未設定に戻せる', async () => {
    await updateBlogForUser({ userId: user.id, blogId }, { penName: 'たろう' });
    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { penName: null },
    );

    expect(updated.penName).toBeNull();
  });

  it('状態を休止に切り替えられる（SPEC 6.1）', async () => {
    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { status: 'PAUSED' },
    );

    expect(updated.status).toBe('PAUSED');
  });
});

describe('投稿頻度（article_ratio.weeklyPublishCap）', () => {
  it('新規作成時は既定値が入る', async () => {
    const blog = await requireBlogForUser({ userId: user.id, blogId });

    expect(blog.articleRatio).toEqual(DEFAULT_ARTICLE_RATIO);
  });

  it.each([1, 2, 3, 4])('週 %s 本を保存できる', async (cap) => {
    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { weeklyPublishCap: cap },
    );

    expect(updated.articleRatio.weeklyPublishCap).toBe(cap);
  });

  it('算出値を消さない（Q-011）', async () => {
    // 構成表の生成後を模して、算出値を書き換えておく
    await prisma.blog.update({
      where: { id: blogId },
      data: { articleRatio: { revenue: 11, traffic: 19, weeklyPublishCap: 4 } },
    });

    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { weeklyPublishCap: 2 },
    );

    expect(updated.articleRatio).toEqual({
      revenue: 11,
      traffic: 19,
      weeklyPublishCap: 2,
    });
  });

  it('他の項目と同時に更新しても算出値を消さない', async () => {
    await prisma.blog.update({
      where: { id: blogId },
      data: { articleRatio: { revenue: 5, traffic: 25, weeklyPublishCap: 4 } },
    });

    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { name: '同時更新', weeklyPublishCap: 1 },
    );

    expect(updated.name).toBe('同時更新');
    expect(updated.articleRatio).toEqual({
      revenue: 5,
      traffic: 25,
      weeklyPublishCap: 1,
    });
  });

  it.each([0, 5, 10])('週 %s 本は 422 で拒否し、DBを変えない', async (cap) => {
    const error = await catchError(
      updateBlogForUser({ userId: user.id, blogId }, { weeklyPublishCap: cap }),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe(ARTICLE_RATIO_ERROR_CODES.invalidPublishCap);

    const blog = await requireBlogForUser({ userId: user.id, blogId });
    expect(blog.articleRatio).toEqual(DEFAULT_ARTICLE_RATIO);
  });

  it('壊れた jsonb でも読めて、上限を保存できる', async () => {
    await prisma.blog.update({
      where: { id: blogId },
      data: { articleRatio: { revenue: 'こわれた' } },
    });

    const updated = await updateBlogForUser(
      { userId: user.id, blogId },
      { weeklyPublishCap: 3 },
    );

    expect(updated.articleRatio).toEqual({
      revenue: DEFAULT_ARTICLE_RATIO.revenue,
      traffic: DEFAULT_ARTICLE_RATIO.traffic,
      weeklyPublishCap: 3,
    });
  });
});

describe('ジャンル（表示のみ・Q-009）', () => {
  it('未審査なら null', async () => {
    const blog = await requireBlogForUser({ userId: user.id, blogId });

    expect(blog.genre).toBeNull();
  });

  it('割り当て済みなら名前とカテゴリを返す', async () => {
    const genre = await prisma.genre.create({
      data: {
        name: '一人暮らしの節約',
        category: '暮らし',
        ymylRisk: 'LOW',
        status: 'APPROVED',
      },
    });
    await prisma.blog.update({
      where: { id: blogId },
      data: { genreId: genre.id },
    });

    const blog = await requireBlogForUser({ userId: user.id, blogId });

    expect(blog.genre).toEqual({
      id: genre.id,
      name: '一人暮らしの節約',
      category: '暮らし',
    });
  });

  it('一覧にもジャンルと記事構成が載る', async () => {
    const genre = await prisma.genre.create({
      data: {
        name: '副業の始め方',
        category: '仕事',
        ymylRisk: 'LOW',
        status: 'APPROVED',
      },
    });
    await prisma.blog.update({
      where: { id: blogId },
      data: { genreId: genre.id },
    });

    const blogs = await listBlogsForUser(user.id);

    expect(blogs).toHaveLength(1);
    expect(blogs[0]?.genre?.name).toBe('副業の始め方');
    expect(blogs[0]?.articleRatio).toEqual(DEFAULT_ARTICLE_RATIO);
  });
});

describe('所有権（B-3 の方針を維持する）', () => {
  it('他人のブログは投稿頻度も変えられず 404', async () => {
    const error = await catchError(
      updateBlogForUser({ userId: other.id, blogId }, { weeklyPublishCap: 1 }),
    );

    expect(error.status).toBe(404);

    // 所有者から見て変わっていない
    const blog = await requireBlogForUser({ userId: user.id, blogId });
    expect(blog.articleRatio.weeklyPublishCap).toBe(4);
  });

  it('不正な上限より先に所有権で弾く', async () => {
    const error = await catchError(
      updateBlogForUser({ userId: other.id, blogId }, { weeklyPublishCap: 99 }),
    );

    // 422 を返すと「そのIDは存在する」と伝わる
    expect(error.status).toBe(404);
  });
});
