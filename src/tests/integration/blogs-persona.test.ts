import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/lib/errors';
import {
  createBlogForUser,
  findBlogForUser,
  updateBlogForUser,
} from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * ブログと分身の結び付きを**実PostgreSQLで**確かめる（TASKS A-2-R-2c）。
 *
 * **ブログは分身の媒体である。** `personaId` は作成時の必須項目で、
 * `blogs.persona_id` は A-2-R-3 で `NOT NULL` になる。
 *
 * 越境（他人の分身IDを渡す）は C-6 の
 * `tenant-isolation.test.ts` が持つ。ここで見るのは**同じ持ち主の中での
 * 決まりごと** — 1分身につきブログ1件、付け替えできないこと。
 */

let prisma: PrismaClient;
let user: { id: string };

function input(
  personaId: string,
  slug: string,
): Parameters<typeof createBlogForUser>[1] {
  return {
    personaId,
    name: `ブログ ${slug}`,
    slug,
    targetReader: '読者',
  };
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
});

describe('作成時に分身を結び付ける', () => {
  it('persona_id が保存され、AppBlog にも載る', async () => {
    const persona = await createPersona(prisma, user.id);

    const blog = await createBlogForUser(user.id, input(persona.id, 'first'));

    expect(blog.personaId).toBe(persona.id);

    // **DBの行まで見る。** 戻り値だけだと、実際に列へ入ったかが分からない
    const row = await prisma.blog.findUnique({
      where: { id: blog.id },
      select: { personaId: true },
    });

    expect(row?.personaId).toBe(persona.id);
  });

  it('取得しても persona_id が付いてくる', async () => {
    const persona = await createPersona(prisma, user.id);
    const created = await createBlogForUser(user.id, input(persona.id, 'get'));

    const found = await findBlogForUser({
      userId: user.id,
      blogId: created.id,
    });

    expect(found?.personaId).toBe(persona.id);
  });

  /**
   * **`DRAFT` の分身でも、モジュールの関数は通る。**
   *
   * 使い始めた分身かどうかは運用方針で、越境の防止ではない。
   * 判定は呼び出し側（`src/app/api/blogs/route.ts`）が持つ
   * — `blogs` から `personas` を import すると循環するため
   * （MODULE_RULES 3「上位へ寄せる」）。
   */
  it('DRAFT の分身でも repository は拒まない（判定は上位）', async () => {
    const persona = await createPersona(prisma, user.id, { status: 'DRAFT' });

    const blog = await createBlogForUser(user.id, input(persona.id, 'draft'));

    expect(blog.personaId).toBe(persona.id);
  });
});

/**
 * **1分身につきブログ1件**（DATA_MODEL 2章「アプリ層の制約」）。
 *
 * Phase 0 の想定。SNS・動画は別媒体として将来追加する。
 */
describe('1分身につきブログ1件', () => {
  it('同じ分身で2件目は作れない', async () => {
    const persona = await createPersona(prisma, user.id);
    await createBlogForUser(user.id, input(persona.id, 'one'));

    const error = await createBlogForUser(
      user.id,
      input(persona.id, 'two'),
    ).then(
      () => null,
      (thrown: unknown) => thrown as AppError,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error?.status).toBe(422);
    expect(await prisma.blog.count({ where: { userId: user.id } })).toBe(1);
  });

  it('分身が違えば2件目を作れる', async () => {
    const first = await createPersona(prisma, user.id);
    const second = await createPersona(prisma, user.id);

    await createBlogForUser(user.id, input(first.id, 'a'));
    const blog = await createBlogForUser(user.id, input(second.id, 'b'));

    expect(blog.slotNumber).toBe(2);
    expect(blog.personaId).toBe(second.id);
  });

  /**
   * **閉じても枠は空かない。** `CLOSED` がスロットを保持し続ける（Q-008）のと
   * 同じ扱い。閉じれば作り直せるようにすると、**同じ分身の媒体が
   * 実験期間中に2本に分かれ、一次データが繋がらなくなる。**
   */
  it('閉じた後でも同じ分身では作れない', async () => {
    const persona = await createPersona(prisma, user.id);
    const blog = await createBlogForUser(user.id, input(persona.id, 'closed'));

    await prisma.blog.update({
      where: { id: blog.id },
      data: { status: 'CLOSED' },
    });

    await expect(
      createBlogForUser(user.id, input(persona.id, 'again')),
    ).rejects.toBeInstanceOf(AppError);
  });
});

/**
 * **付け替えられない**（A-2-R-2c）。
 *
 * 付け替えると、それまでに書いた記事の書き手が後から変わる。
 * 別の分身で書くなら別のブログを作る。
 */
describe('分身の付け替え', () => {
  it('更新の入力に personaId は無い', async () => {
    const persona = await createPersona(prisma, user.id);
    const other = await createPersona(prisma, user.id);
    const blog = await createBlogForUser(user.id, input(persona.id, 'keep'));

    // `UpdateBlogInput` に `personaId` が無いことを、型ではなく
    // **実際に渡して確かめる**（型は消えるが列は残る）
    const updated = await updateBlogForUser(
      { userId: user.id, blogId: blog.id },
      { personaId: other.id, name: '名前だけ変える' } as Parameters<
        typeof updateBlogForUser
      >[1],
    );

    expect(updated.name).toBe('名前だけ変える');
    expect(updated.personaId).toBe(persona.id);
  });
});

/**
 * 公開スケジュールが割り当てられる（TASKS C-9、作業指示書 W-8）。
 *
 * **全ブログの投稿ジョブが同一時刻に集中しないこと**が完了条件。
 */
describe('公開スケジュールの割り当て', () => {
  it('作成時に埋まる', async () => {
    const persona = await createPersona(prisma, user.id);

    const blog = await createBlogForUser(user.id, input(persona.id, 'sched'));

    expect(blog.publishWeekdays.length).toBeGreaterThan(0);
    expect(blog.publishTime).toMatch(/^\d{2}:\d{2}$/);
    expect(blog.publishJitterMin).toBeGreaterThanOrEqual(0);
    expect(blog.initialArticleCount).toBeGreaterThanOrEqual(28);

    // **DBの行まで見る**（戻り値だけだと列へ入ったか分からない）
    const row = await prisma.blog.findUniqueOrThrow({
      where: { id: blog.id },
      select: { publishWeekdays: true, publishTime: true },
    });

    expect(row.publishWeekdays).toEqual(blog.publishWeekdays);
    expect(row.publishTime).not.toBeNull();
  });

  /** **同じ種なら同じ値**（ランダムにしない） */
  it('同じ利用者の別スロットには別の割り当てが入りうる', async () => {
    const first = await createPersona(prisma, user.id);
    const second = await createPersona(prisma, user.id);

    const a = await createBlogForUser(user.id, input(first.id, 'sched-a'));
    const b = await createBlogForUser(user.id, input(second.id, 'sched-b'));

    // 枠が違えば種が違う。**必ず違う値とは限らない**ので、
    // ここでは「両方とも埋まっている」ことだけを見る
    expect(a.publishTime).not.toBeNull();
    expect(b.publishTime).not.toBeNull();
    expect(a.slotNumber).not.toBe(b.slotNumber);
  });
});
