import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import {
  assignGenreForAdmin,
  createBlogForUser,
  createGenre,
  requireBlogForUser,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * ジャンルの種と割り当てを**実PostgreSQLで**確かめる（Q-049、E-4）。
 *
 * **`blogs.genre_id` に値を入れる経路がコードのどこにも無かった**
 * ため、段7は誰にも通せなかった（Q-048）。ここで見張るのは2つ。
 *
 * - **同じ分類の中で `ymylRisk` が食い違わない**
 *   （1つ付け忘れると、そこだけ停止条件を素通りする）
 * - 割り当てがブログに反映される
 *
 * **種そのものは `genre-seed.test.ts` が見張る。** `resetDatabase` は
 * `genres` も消すので、ここでDBの中身を確かめると**テストの前提を
 * 見ているだけ**になる。
 */

let prisma: PrismaClient;
let owner: { id: string };
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

  owner = await createUser(prisma);
  const persona = await createPersona(prisma, owner.id);
  const blog = await createBlogForUser(owner.id, {
    personaId: persona.id,
    name: 'ブログ',
    slug: 'blog',
    targetReader: '読者',
  });

  blogId = blog.id;
});

describe('ジャンルを足す', () => {
  it('細かい名前を、粗い分類の下に足せる', async () => {
    await createGenre({
      name: '投資・資産運用',
      category: '投資・資産運用',
      ymylRisk: 'HIGH',
    });

    const created = await createGenre({
      name: 'つみたてNISA',
      category: '投資・資産運用',
      ymylRisk: 'HIGH',
    });

    expect(created).toMatchObject({
      name: 'つみたてNISA',
      category: '投資・資産運用',
      ymylRisk: 'HIGH',
      // **足した時点では候補。** 審査を経ていない
      status: 'CANDIDATE',
    });
  });

  /**
   * **1つ付け忘れると、そこだけ停止条件を素通りする。**
   * 「投資＞つみたてNISA」だけ `LOW` にできてしまうのを止める。
   */
  it('同じ分類で ymylRisk が食い違うと弾く', async () => {
    // **同じ分類の先行行を自分で用意する。** `resetDatabase` が
    // `genres` も消すため、種があることを前提にしない
    await createGenre({
      name: '投資・資産運用',
      category: '投資・資産運用',
      ymylRisk: 'HIGH',
    });

    await expect(
      createGenre({
        name: 'つみたてNISA',
        category: '投資・資産運用',
        ymylRisk: 'LOW',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('同じ名前は足せない', async () => {
    await createGenre({
      name: '格安SIM',
      category: '通信',
      ymylRisk: 'LOW',
    });

    await expect(
      createGenre({ name: '格安SIM', category: '通信', ymylRisk: 'LOW' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('ブログへ割り当てる', () => {
  it('割り当てるとブログから引ける', async () => {
    const genre = await createGenre({
      name: '格安SIM',
      category: '通信',
      ymylRisk: 'LOW',
    });

    await assignGenreForAdmin({ blogId, genreId: genre.id });

    const blog = await requireBlogForUser({ userId: owner.id, blogId });

    expect(blog.genre).toMatchObject({ name: '格安SIM', category: '通信' });
  });

  it('無いブログは 404', async () => {
    const genre = await createGenre({
      name: '光回線',
      category: '通信',
      ymylRisk: 'LOW',
    });

    await expect(
      assignGenreForAdmin({
        blogId: '00000000-0000-0000-0000-000000000000',
        genreId: genre.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('無いジャンルは 422', async () => {
    await expect(
      assignGenreForAdmin({
        blogId,
        genreId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
