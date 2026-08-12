import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  PERSONA_ERROR_CODES,
  findBlogPersonaSettingForUser,
  resolveEffectivePersonaForUser,
  saveBlogPersonaSettingForUser,
  saveUserPersonaForUser,
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
  targetReader: {
    ageRange: '20代',
    situation: '初めて選ぶ',
    knowledgeLevel: 'beginner',
  },
  ngTopics: ['医療行為'],
  writingRules: { headingDepth: 3, leadLength: 120, bulletFrequency: 'mid' },
};

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;

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

  await saveUserPersonaForUser(owner.id, {
    baseProfile: {
      ageRange: '30代',
      position: '会社員',
      firstPerson: '私',
      background: '美容が好き',
    },
    tone: TONE,
    values: { priorities: ['正直さ'], avoid: ['煽り'] },
    ngExpressions: ['絶対に'],
  });

  blog1 = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
      name: 'ブログ1',
      slug: 'mine-1',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  blog2 = (
    await createBlogForUser(owner.id, {
      personaId: (await createPersona(prisma, owner.id)).id,
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
    expect(saved.targetReader).toEqual(SETTING.targetReader);
    expect(saved.writingRules).toEqual(SETTING.writingRules);
  });

  /**
   * **参照先の `persona_facts` は D-6 で作る。** 所有権を確かめられない
   * IDを受け取ると、他人の体験を引き当てられる（C-6 と同じ形）。
   */
  it('allowed_experiences は入力から設定できない', async () => {
    const saved = await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      {
        ...SETTING,
        allowedExperiences: ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
      } as SaveBlogPersonaSettingInput,
    );

    expect(saved.allowedExperiences).toEqual([]);
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
  it('共通人格に上書きを重ねて返す', async () => {
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
    expect(effective.baseProfile.firstPerson).toBe('私');
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

  /** 共通人格が無ければ、そもそも書き手が決まらない */
  it('共通人格が未登録なら404', async () => {
    await expect(
      resolveEffectivePersonaForUser({ userId: other.id, blogId: otherBlog }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
