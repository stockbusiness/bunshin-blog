import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import {
  BLOG_SLOT_ERROR_CODES,
  closeBlogForUser,
  createBlogForUser,
  getSlotUsageForUser,
  listBlogsForUser,
  type CreateBlogInput,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 3ブログ上限とスロット制御を**実PostgreSQLで**検証する（TASKS B-4）。
 *
 * 完了条件「4件目の登録が拒否される」「slot重複が拒否される」
 * 「`CLOSED` のスロットを再利用できない（OPEN_QUESTIONS Q-008）」。
 *
 * 判定そのものは純粋関数の単体テスト（`src/tests/modules/blogs/slots.test.ts`）で
 * 固めてある。ここで確かめるのは、**使用状況の集計が `CLOSED` を含む行を
 * 実際に拾えているか**と、DB側の制約と食い違わないこと。
 */

let prisma: PrismaClient;
let user: { id: string };
let other: { id: string };

let sequence = 0;

/**
 * **呼ぶたびに新しい分身を作る**（A-2-R-2c）。
 *
 * ブログは分身の媒体で、**1分身につきブログ1件**（DATA_MODEL 2章）。
 * 使い回すと、スロットの判定を確かめる前に「この分身のブログはすでにあります」で
 * 落ちてしまう。
 */
async function blogInput(
  userId: string,
  overrides: Partial<CreateBlogInput> = {},
): Promise<CreateBlogInput> {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');

  return {
    personaId: (await createPersona(prisma, userId)).id,
    name: `ブログ${suffix}`,
    slug: `slot-blog-${suffix}`,
    targetReader: 'テスト読者',
    ...overrides,
  };
}

/** `createBlogForUser` が投げた `AppError` を取り出す */
async function catchError(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as AppError,
  );
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

  user = await createUser(prisma, { displayName: 'モニター' });
  other = await createUser(prisma, { displayName: '別モニター' });
});

describe('3件上限（SPEC 2.5）', () => {
  it('3件までは作れ、スロットが1から順に割り当てられる', async () => {
    const first = await createBlogForUser(user.id, await blogInput(user.id));
    const second = await createBlogForUser(user.id, await blogInput(user.id));
    const third = await createBlogForUser(user.id, await blogInput(user.id));

    expect([first.slotNumber, second.slotNumber, third.slotNumber]).toEqual([
      1, 2, 3,
    ]);
  });

  it('4件目は 409 で拒否される', async () => {
    await createBlogForUser(user.id, await blogInput(user.id));
    await createBlogForUser(user.id, await blogInput(user.id));
    await createBlogForUser(user.id, await blogInput(user.id));

    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id)),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);
    expect(await prisma.blog.count({ where: { userId: user.id } })).toBe(3);
  });

  it('4件目はスロットを明示しても拒否される', async () => {
    for (const slotNumber of [1, 2, 3]) {
      await createBlogForUser(
        user.id,
        await blogInput(user.id, { slotNumber }),
      );
    }

    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id, { slotNumber: 2 })),
    );

    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);
  });

  it('上限はユーザーごと。別ユーザーは影響を受けない', async () => {
    await createBlogForUser(user.id, await blogInput(user.id));
    await createBlogForUser(user.id, await blogInput(user.id));
    await createBlogForUser(user.id, await blogInput(user.id));

    const theirs = await createBlogForUser(other.id, await blogInput(other.id));

    expect(theirs.slotNumber).toBe(1);
    expect(theirs.userId).toBe(other.id);
  });
});

describe('スロット重複', () => {
  it('同じスロットの指定は 409 で拒否される', async () => {
    await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 2 }),
    );

    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id, { slotNumber: 2 })),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.slotTaken);
    expect(error.details).toEqual({ slotNumber: 2, closed: false });
  });

  it('別ユーザーなら同じスロット番号を使える', async () => {
    const mine = await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 1 }),
    );
    const theirs = await createBlogForUser(
      other.id,
      await blogInput(other.id, { slotNumber: 1 }),
    );

    expect(mine.slotNumber).toBe(theirs.slotNumber);
    expect(mine.id).not.toBe(theirs.id);
  });

  it('範囲外のスロットは 422 で拒否され、DBへ届かない', async () => {
    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id, { slotNumber: 4 })),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.outOfRange);
    expect(await prisma.blog.count({ where: { userId: user.id } })).toBe(0);
  });

  it('DB側にも CHECK 制約が効いている（アプリ層を迂回した場合）', async () => {
    // アプリ層の判定を通さず直接 insert すると、DBが拒否する。
    // 判定をアプリ層だけに置かないこと（DATA_MODEL 4章）の確認
    await expect(
      prisma.blog.create({
        data: {
          userId: user.id,
          personaId: (await createPersona(prisma, user.id)).id,
          name: '範囲外',
          slug: 'out-of-range',
          targetReader: 'テスト読者',
          articleRatio: {},
          slotNumber: 4,
          // **狙った制約で落ちることを確かめる。** 省くと
          // `publish_time` の NOT NULL で落ち、slot_range を通らない
          publishTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0, 0)),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('CLOSED のスロットは再利用できない（Q-008）', () => {
  it('閉じたスロットを指定すると 409 で拒否される', async () => {
    const blog = await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 1 }),
    );
    await closeBlogForUser({ userId: user.id, blogId: blog.id });

    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id, { slotNumber: 1 })),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.slotTaken);
    expect(error.details).toEqual({ slotNumber: 1, closed: true });
    expect(error.message).toContain('再利用できません');
  });

  it('閉じたスロットは自動割り当てでも飛ばされる', async () => {
    const blog = await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 1 }),
    );
    await closeBlogForUser({ userId: user.id, blogId: blog.id });

    const next = await createBlogForUser(user.id, await blogInput(user.id));

    expect(next.slotNumber).toBe(2);
  });

  it('3件すべて閉じても新しく作れない', async () => {
    for (const slotNumber of [1, 2, 3]) {
      const blog = await createBlogForUser(
        user.id,
        await blogInput(user.id, { slotNumber }),
      );
      await closeBlogForUser({ userId: user.id, blogId: blog.id });
    }

    const error = await catchError(
      createBlogForUser(user.id, await blogInput(user.id)),
    );

    expect(error.code).toBe(BLOG_SLOT_ERROR_CODES.limitReached);

    // 一覧は空に見えるが、枠は埋まったまま
    expect(await listBlogsForUser(user.id)).toEqual([]);
    expect((await getSlotUsageForUser(user.id)).remaining).toBe(0);
  });
});

describe('getSlotUsageForUser', () => {
  it('未使用なら3枠すべてが空き', async () => {
    const usage = await getSlotUsageForUser(user.id);

    expect(usage).toEqual({
      limit: 3,
      used: [],
      available: [1, 2, 3],
      remaining: 3,
    });
  });

  it('CLOSED を使用中として数える（一覧との違い）', async () => {
    const blog = await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 2 }),
    );
    await closeBlogForUser({ userId: user.id, blogId: blog.id });

    const usage = await getSlotUsageForUser(user.id);

    expect(usage.used).toEqual([
      { slotNumber: 2, blogId: blog.id, status: 'CLOSED' },
    ]);
    expect(usage.available).toEqual([1, 3]);
    expect(usage.remaining).toBe(2);

    // 一覧からは消えている（SPEC 13.2）
    expect(await listBlogsForUser(user.id)).toEqual([]);
  });

  it('他ユーザーのブログを数えない', async () => {
    await createBlogForUser(
      other.id,
      await blogInput(other.id, { slotNumber: 1 }),
    );
    await createBlogForUser(
      other.id,
      await blogInput(other.id, { slotNumber: 2 }),
    );

    const usage = await getSlotUsageForUser(user.id);

    expect(usage.remaining).toBe(3);
    expect(usage.used).toEqual([]);
  });

  it('スロット順に並ぶ', async () => {
    await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 3 }),
    );
    await createBlogForUser(
      user.id,
      await blogInput(user.id, { slotNumber: 1 }),
    );

    const usage = await getSlotUsageForUser(user.id);

    expect(usage.used.map((entry) => entry.slotNumber)).toEqual([1, 3]);
    expect(usage.available).toEqual([2]);
  });
});
