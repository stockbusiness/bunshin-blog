import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  createPersonaFactForUser,
  deletePersonaFactForUser,
  findPersonaFactForUser,
  listPersonaFactsForUser,
  requirePersonaFactForUser,
  saveBlogPersonaSettingForUser,
  setAllowedExperiencesForUser,
  updatePersonaFactForUser,
  type CreatePersonaFactInput,
} from '@/modules/personas';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 本人の事実を**実PostgreSQLで**確かめる（TASKS D-6）。
 *
 * 完了条件は「**`AI_INFERENCE` かつ `UNVERIFIED` が一人称利用不可の
 * フラグを持つ**」。規則そのものは
 * `src/tests/modules/personas/facts.test.ts` の担当で、ここで見るのは
 * **保存された値**と**所有権**。
 */

const SETTING = {
  penName: 'あおい',
  targetReader: {
    ageRange: '20代',
    situation: '初めて選ぶ',
    knowledgeLevel: 'beginner' as const,
  },
  writingRules: {
    headingDepth: 3,
    leadLength: 120,
    bulletFrequency: 'mid' as const,
  },
};

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;

function input(
  overrides: Partial<CreatePersonaFactInput> = {},
): CreatePersonaFactInput {
  return {
    factType: 'EXPERIENCE',
    content: '半年ほど使いました',
    source: 'USER_INPUT',
    ...overrides,
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

  owner = await createUser(prisma, { displayName: '所有者' });
  other = await createUser(prisma, { displayName: '別ユーザー' });

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

describe('一人称利用の制限（完了条件）', () => {
  /** **保存された値そのものを見る。** 呼び出し側の指定は通らない */
  it('AI_INFERENCE かつ UNVERIFIED では false で保存される', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({
        source: 'AI_INFERENCE',
        verification: 'UNVERIFIED',
        usableFirstPerson: true,
      }),
    );

    expect(fact.usableFirstPerson).toBe(false);

    const row = await prisma.personaFact.findUniqueOrThrow({
      where: { id: fact.id },
      select: { usableFirstPerson: true },
    });
    expect(row.usableFirstPerson).toBe(false);
  });

  it('裏取りが通れば true で保存される', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({
        source: 'AI_INFERENCE',
        verification: 'VERIFIED',
        usableFirstPerson: true,
      }),
    );

    expect(fact.usableFirstPerson).toBe(true);
  });

  /**
   * **後から組み合わせが変わった場合も落とす。**
   * 保存時だけ見ていると、`VERIFIED` → `UNVERIFIED` で通り抜ける。
   */
  it('裏取りを戻すと一人称利用も落ちる', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({
        source: 'AI_INFERENCE',
        verification: 'VERIFIED',
        usableFirstPerson: true,
      }),
    );

    const updated = await updatePersonaFactForUser(
      { userId: owner.id, factId: fact.id },
      { verification: 'UNVERIFIED' },
    );

    expect(updated.usableFirstPerson).toBe(false);
  });

  it('出どころを AI_INFERENCE に変えても落ちる', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({
        source: 'USER_INPUT',
        verification: 'UNVERIFIED',
        usableFirstPerson: true,
      }),
    );
    expect(fact.usableFirstPerson).toBe(true);

    const updated = await updatePersonaFactForUser(
      { userId: owner.id, factId: fact.id },
      { source: 'AI_INFERENCE' },
    );

    expect(updated.usableFirstPerson).toBe(false);
  });

  it('REJECTED にすると落ちる', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({ verification: 'VERIFIED', usableFirstPerson: true }),
    );

    const updated = await updatePersonaFactForUser(
      { userId: owner.id, factId: fact.id },
      { verification: 'REJECTED' },
    );

    expect(updated.usableFirstPerson).toBe(false);
  });

  it('一人称で使える事実だけを絞り込める', async () => {
    await createPersonaFactForUser(
      owner.id,
      input({ verification: 'VERIFIED', usableFirstPerson: true }),
    );
    await createPersonaFactForUser(
      owner.id,
      input({
        content: 'AIが推測した体験',
        source: 'AI_INFERENCE',
        usableFirstPerson: true,
      }),
    );

    const usable = await listPersonaFactsForUser(owner.id, {
      usableFirstPersonOnly: true,
    });

    expect(usable).toHaveLength(1);
    expect(usable[0]?.content).toBe('半年ほど使いました');
  });
});

describe('ブログとの紐付け', () => {
  it('ブログ固有の事実を作れる', async () => {
    const fact = await createPersonaFactForUser(
      owner.id,
      input({ blogId: blog1 }),
    );

    expect(fact.blogId).toBe(blog1);
  });

  /** 他人のブログに紐づく事実を作られると、そのブログの生成へ混ざる */
  it('他人のブログには紐づけられない', async () => {
    await expect(
      createPersonaFactForUser(owner.id, input({ blogId: otherBlog })),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.personaFact.count()).toBe(0);
  });

  /** 記事生成（E-8）が使う形 */
  it('一覧はブログ固有と全ブログ共通を返す', async () => {
    await createPersonaFactForUser(owner.id, input({ content: '共通の事実' }));
    await createPersonaFactForUser(
      owner.id,
      input({ content: 'ブログ1の事実', blogId: blog1 }),
    );
    await createPersonaFactForUser(
      owner.id,
      input({ content: 'ブログ2の事実', blogId: blog2 }),
    );

    const facts = await listPersonaFactsForUser(owner.id, { blogId: blog1 });

    expect(facts.map((fact) => fact.content).sort()).toEqual(
      ['ブログ1の事実', '共通の事実'].sort(),
    );
  });
});

describe('所有権（SPEC 14.1）', () => {
  let factId: string;

  beforeEach(async () => {
    factId = (await createPersonaFactForUser(owner.id, input())).id;
  });

  it('他人の事実は引けない', async () => {
    expect(
      await findPersonaFactForUser({ userId: other.id, factId }),
    ).toBeNull();
  });

  it('他人の事実は404', async () => {
    await expect(
      requirePersonaFactForUser({ userId: other.id, factId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('他人の事実は編集できない', async () => {
    await expect(
      updatePersonaFactForUser(
        { userId: other.id, factId },
        { content: '書き換え' },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const row = await prisma.personaFact.findUniqueOrThrow({
      where: { id: factId },
      select: { content: true },
    });
    expect(row.content).toBe('半年ほど使いました');
  });

  it('他人の事実は消せない', async () => {
    await expect(
      deletePersonaFactForUser({ userId: other.id, factId }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.personaFact.count()).toBe(1);
  });

  it('一覧に他人の事実は出ない', async () => {
    await createPersonaFactForUser(other.id, input({ content: '他人の事実' }));

    const facts = await listPersonaFactsForUser(owner.id);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.userId).toBe(owner.id);
  });
});

/**
 * **D-5 で保留した入口。** 参照先の `persona_facts` が無い間は、所有権を
 * 確かめられないIDを保存することになるため出さなかった。
 */
describe('使ってよい体験の設定', () => {
  let factId: string;

  beforeEach(async () => {
    await saveBlogPersonaSettingForUser(
      { userId: owner.id, blogId: blog1 },
      SETTING,
    );
    factId = (await createPersonaFactForUser(owner.id, input())).id;
  });

  it('自分の事実を設定できる', async () => {
    const setting = await setAllowedExperiencesForUser(
      { userId: owner.id, blogId: blog1 },
      [factId],
    );

    expect(setting.allowedExperiences).toEqual([factId]);
  });

  /** **C-6 で見つけたのと同じ形の穴を作らない** */
  it('他人の事実は設定できない', async () => {
    const theirFact = (await createPersonaFactForUser(other.id, input())).id;

    await expect(
      setAllowedExperiencesForUser({ userId: owner.id, blogId: blog1 }, [
        theirFact,
      ]),
    ).rejects.toMatchObject({ status: 404 });

    const setting = await prisma.blogPersonaSetting.findFirstOrThrow({
      where: { blogId: blog1 },
      select: { allowedExperiences: true },
    });
    expect(setting.allowedExperiences).toEqual([]);
  });

  it('存在しない事実は設定できない', async () => {
    await expect(
      setAllowedExperiencesForUser({ userId: owner.id, blogId: blog1 }, [
        '00000000-0000-4000-8000-000000000000',
      ]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('自分と他人が混ざっていれば丸ごと拒否する', async () => {
    const theirFact = (await createPersonaFactForUser(other.id, input())).id;

    await expect(
      setAllowedExperiencesForUser({ userId: owner.id, blogId: blog1 }, [
        factId,
        theirFact,
      ]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('重複を落とす', async () => {
    const setting = await setAllowedExperiencesForUser(
      { userId: owner.id, blogId: blog1 },
      [factId, factId],
    );

    expect(setting.allowedExperiences).toEqual([factId]);
  });

  it('空にできる', async () => {
    await setAllowedExperiencesForUser({ userId: owner.id, blogId: blog1 }, [
      factId,
    ]);

    const setting = await setAllowedExperiencesForUser(
      { userId: owner.id, blogId: blog1 },
      [],
    );

    expect(setting.allowedExperiences).toEqual([]);
  });

  /**
   * **消した事実へのIDが残ると、記事生成が引けない参照を掴む。**
   */
  it('事実を消すと参照からも外れる', async () => {
    await setAllowedExperiencesForUser({ userId: owner.id, blogId: blog1 }, [
      factId,
    ]);

    await deletePersonaFactForUser({ userId: owner.id, factId });

    const setting = await prisma.blogPersonaSetting.findFirstOrThrow({
      where: { blogId: blog1 },
      select: { allowedExperiences: true },
    });
    expect(setting.allowedExperiences).toEqual([]);
  });

  it('未設定のブログには設定できない', async () => {
    await expect(
      setAllowedExperiencesForUser({ userId: owner.id, blogId: blog2 }, [
        factId,
      ]),
    ).rejects.toMatchObject({ status: 404 });
  });
});
