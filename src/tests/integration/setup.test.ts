import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 統合テスト基盤の疎通確認（TASKS A-9）。
 *
 * ここでは基盤が動くことだけを確かめる。**テナント越境の検証は C-6**
 * （TASKS.md「C-6は必ず単独タスクにする」）。
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

describe('統合テスト基盤', () => {
  it('実PostgreSQLへ接続できる', async () => {
    const rows =
      await prisma.$queryRawUnsafe<{ ok: number }[]>('select 1 as ok');

    expect(rows[0]?.ok).toBe(1);
  });

  /**
   * **数を固定しておく。** テーブルが黙って増減したときに気づくため。
   * A-2-R-1 で `personas` を足して 28 → 29、**A-2-R-3 で `user_personas` を
   * 落として 28 に戻った**（並存は移行のあいだだけだった）。
   * J-7 で `fact_issues` を足して 29。
   */
  it('マイグレーションで29テーブルが作られている', async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `select count(*)::bigint as count from information_schema.tables
       where table_schema = 'public' and table_name <> '_prisma_migrations'`,
    );

    expect(Number(rows[0]?.count ?? 0)).toBe(29);
  });

  it('ユーザーとブログを作れる', async () => {
    const user = await createUser(prisma);
    const blog = await createBlog(prisma, user.id);

    expect(blog.userId).toBe(user.id);
    expect(await prisma.blog.count()).toBe(1);
  });

  // 各テストが前のテストのデータを引きずらないこと
  it('テストごとにデータが消えている', async () => {
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.blog.count()).toBe(0);
  });

  it('外部キーがあってもリセットできる', async () => {
    const user = await createUser(prisma);
    await createBlog(prisma, user.id);

    await resetDatabase(prisma);

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.blog.count()).toBe(0);
  });
});

// DATA_MODEL 4章でDB側にも入れると定めた制約が、実際に効いていること
describe('DBのCHECK制約', () => {
  it('slot_number が4のブログを拒否する', async () => {
    const user = await createUser(prisma);

    await expect(
      createBlog(prisma, user.id, { slotNumber: 4 }),
    ).rejects.toThrow();
  });

  it('slot_number が1〜3なら通す', async () => {
    const user = await createUser(prisma);

    for (const slotNumber of [1, 2, 3]) {
      const blog = await createBlog(prisma, user.id, { slotNumber });
      expect(blog.slotNumber).toBe(slotNumber);
    }
  });

  // UNIQUE(user_id, slot_number)。3ブログ上限の土台（SPEC 2.5）
  it('同じユーザーで slot_number が重複するとエラーになる', async () => {
    const user = await createUser(prisma);
    await createBlog(prisma, user.id, { slotNumber: 1 });

    await expect(
      createBlog(prisma, user.id, { slotNumber: 1 }),
    ).rejects.toThrow();
  });
});
