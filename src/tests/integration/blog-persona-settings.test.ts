import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  PERSONA_ERROR_CODES,
  findBlogPersonaSettingForUser,
  resolveEffectivePersonaForUser,
  saveBlogPersonaSettingForUser,
  updateBlogPersonaSettingForUser,
  type SaveBlogPersonaSettingInput,
} from '@/modules/personas';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * ブログ別の人格設定を**実PostgreSQLで**確かめる（TASKS D-5）。
 *
 * 完了条件は「**ブログ別の上書き設定が保存される**」。
 * 重ね合わせの規則そのものは `src/tests/modules/personas/blog-settings.test.ts`
 * の担当で、ここで見るのは**保存とブログ別の分離**。
 */

const TONE = {
  style: 'やわらかい語り口',
  emojiLevel: 'low' as const,
  lineBreak: 'short' as const,
  politeness: 'ですます',
};

const SETTING: SaveBlogPersonaSettingInput = {
  penName: 'あおい',
  toneOverride: { emojiLevel: 'none' },
  ngTopics: ['医療行為'],
  writingRules: { headingDepth: 3, leadLength: 120, bulletFrequency: 'mid' },
};

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;
let persona1: string;

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

  // **文体は分身が持つ**（A-2-R-2d）。重ね合わせの相手を固定するため、
  // ここで作る分身の `identity.tone` を明示する
  persona1 = (await createPersona(prisma, owner.id, { tone: TONE })).id;

  blog1 = (
    await createBlogForUser(owner.id, {
      personaId: persona1,
      name: 'ブログ1',
      slug: 'mine-1',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  blog2 = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id, { tone: TONE })).id,
      name: 'ブログ2',
      slug: 'mine-2',
      targetReader: '読者',
      slotNumber: 2,
    })
  ).id;
  otherBlog = (
    await createBlogForUser(other.id, {
      personaId: (await createPersona(prisma, other.id)).id,
      name: '他人のブログ',
      slug: 'theirs',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
});

describe('保存（完了条件）', () => {
  it('未設定なら null', async () => {
    expect(
      await findBlogPersonaSettingForUser({ userId: owner.id, blogId: blog1 }),
    ).toBeNull();
  });

  it('入れた形のまま戻ってくる', async () => {
    const saved = await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );

    expect(saved).toMatchObject({
      blogId: blog1,
      penName: 'あおい',
      ngTopics: ['医療行為'],
    });
    expect(saved.toneOverride).toEqual({ emojiLevel: 'none' });
    expect(saved.writingRules).toEqual(SETTING.writingRules);
  });

  it('2回保存しても行は増えない', async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      { ...SETTING, penName: 'みどり' },
    );

    expect(await prisma.blogPersonaSetting.count()).toBe(1);
  });

  it('他人のブログには保存できない', async () => {
    await expect(
      saveBlogPersonaSettingForUser(
        { userId: owner.id, blogId: otherBlog },
        SETTING,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.blogPersonaSetting.count()).toBe(0);
  });

  it('CLOSED のブログには保存できない', async () => {
    await prisma.blog.update({
      where: { id: blog1 },
      data: { status: 'CLOSED' },
    });

    await expect(
      saveBlogPersonaSettingForUser(
        { userId: owner.id, blogId: blog1 },
        SETTING,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('編集', () => {
  beforeEach(async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );
  });

  it('渡した項目だけ変わる', async () => {
    const updated = await updateBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      { penName: 'みどり' },
    );

    expect(updated.penName).toBe('みどり');
    expect(updated.toneOverride).toEqual({ emojiLevel: 'none' });
  });

  it('上書きを空に戻せる', async () => {
    const updated = await updateBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      { toneOverride: {} },
    );

    expect(updated.toneOverride).toEqual({});
  });

  it('未設定のブログは編集できない', async () => {
    await expect(
      updateBlogPersonaSettingForUser(
        { userId: owner.id, blogId: blog2 },
        { penName: 'みどり' },
      ),
    ).rejects.toMatchObject({
      code: PERSONA_ERROR_CODES.notFound,
      status: 404,
    });
  });

  it('壊れた形は保存されない', async () => {
    await expect(
      updateBlogPersonaSettingForUser(
        { userId: owner.id, blogId: blog1 },
        {
          writingRules: {
            headingDepth: 9,
            leadLength: 120,
            bulletFrequency: 'mid',
          },
        },
      ),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.invalidPersona });

    const setting = await findBlogPersonaSettingForUser({
      userId: owner.id,
      blogId: blog1,
    });
    expect(setting?.writingRules.headingDepth).toBe(3);
  });
});

describe('ブログ別の分離', () => {
  it('別のブログには影響しない', async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );

    expect(
      await findBlogPersonaSettingForUser({ userId: owner.id, blogId: blog2 }),
    ).toBeNull();
  });

  it('ブログごとに別の上書きを持てる', async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog2 },
      { ...SETTING, penName: 'みどり', toneOverride: { politeness: 'である' } },
    );

    const first = await resolveEffectivePersonaForUser({
      userId: owner.id,
      blogId: blog1,
    });
    const second = await resolveEffectivePersonaForUser({
      userId: owner.id,
      blogId: blog2,
    });

    expect(first.tone.emojiLevel).toBe('none');
    expect(first.tone.politeness).toBe('ですます');
    expect(second.tone.emojiLevel).toBe('low');
    expect(second.tone.politeness).toBe('である');
  });

  it('他人のブログの設定は引けない', async () => {
    await expect(
      findBlogPersonaSettingForUser({ userId: owner.id, blogId: otherBlog }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('記事生成が使う人格', () => {
  it('分身に上書きを重ねて返す', async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );

    const effective = await resolveEffectivePersonaForUser({
      userId: owner.id,
      blogId: blog1,
    });

    expect(effective.tone).toEqual({ ...TONE, emojiLevel: 'none' });
    expect(effective.penName).toBe('あおい');
    // **どの分身で書くかはブログが持つ**（`blogs.persona_id`・A-2-R-2c）
    expect(effective.personaId).toBe(persona1);
  });

  /** 設定前のブログでも記事は書けるべき */
  it('ブログ別設定が無くても組み立てられる', async () => {
    const effective = await resolveEffectivePersonaForUser({
      userId: owner.id,
      blogId: blog2,
    });

    expect(effective.tone).toEqual(TONE);
    expect(effective.penName).toBeNull();
  });

  /**
   * **分身の割り当てが無いブログでは書き手が決まらない。**
   * A-2-R-2c より前に作られた行だけがこの状態になりうる
   * （`blogs.persona_id` は A-2-R-3 で NOT NULL）。
   * **推測で既定の分身を当てない** — 誰が書いた記事か分からなくなる
   */
  it('分身の割り当てが無いブログは404', async () => {
    await prisma.blog.update({
      where: { id: blog2 },
      data: { personaId: null },
    });

    await expect(
      resolveEffectivePersonaForUser({ userId: owner.id, blogId: blog2 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('他人のブログでは組み立てられない', async () => {
    await expect(
      resolveEffectivePersonaForUser({ userId: owner.id, blogId: otherBlog }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
