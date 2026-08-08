import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  PERSONA_ERROR_CODES,
  findUserPersonaForUser,
  requireUserPersonaForUser,
  saveUserPersonaForUser,
  updateUserPersonaForUser,
  type CreateUserPersonaInput,
} from '@/modules/personas';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * ユーザー共通人格を**実PostgreSQLで**確かめる（TASKS D-4）。
 *
 * 完了条件は「**ユーザー共通人格を編集できる**」。
 *
 * `jsonb` の読み書きは差し替えでは確かめられない。**入れた形のまま
 * 戻ってくるか**（Prisma の `Json` は取り違えやすい）を実DBで見る。
 */

const BASE_PROFILE = {
  ageRange: '30代',
  position: '会社員',
  firstPerson: '私',
  background: '美容の情報を集めるのが好き',
};

const TONE = {
  style: 'やわらかい語り口',
  emojiLevel: 'low' as const,
  lineBreak: 'short' as const,
  politeness: 'ですます',
};

const VALUES = { priorities: ['正直さ'], avoid: ['煽り'] };

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };

function input(
  overrides: Partial<CreateUserPersonaInput> = {},
): CreateUserPersonaInput {
  return {
    baseProfile: BASE_PROFILE,
    tone: TONE,
    values: VALUES,
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
});

describe('登録', () => {
  it('未登録なら null', async () => {
    expect(await findUserPersonaForUser(owner.id)).toBeNull();
  });

  it('未登録で必須にすると404', async () => {
    await expect(requireUserPersonaForUser(owner.id)).rejects.toMatchObject({
      code: PERSONA_ERROR_CODES.notFound,
      status: 404,
    });
  });

  /** `jsonb` は Prisma の `Json` で取り違えやすい */
  it('入れた形のまま戻ってくる', async () => {
    const saved = await saveUserPersonaForUser(
      owner.id,
      input({ ngExpressions: ['絶対に'] }),
    );

    expect(saved.baseProfile).toEqual(BASE_PROFILE);
    expect(saved.tone).toEqual(TONE);
    expect(saved.values).toEqual(VALUES);
    expect(saved.ngExpressions).toEqual(['絶対に']);

    const reloaded = await findUserPersonaForUser(owner.id);
    expect(reloaded?.baseProfile).toEqual(BASE_PROFILE);
    expect(reloaded?.tone).toEqual(TONE);
  });

  /**
   * `user_id` は unique。**「引いてから入れる」を分けない**ので、
   * 2回呼んでも行は増えない。
   */
  it('2回保存しても行は増えない', async () => {
    await saveUserPersonaForUser(owner.id, input());
    await saveUserPersonaForUser(
      owner.id,
      input({ baseProfile: { ...BASE_PROFILE, position: '自営業' } }),
    );

    expect(await prisma.userPersona.count()).toBe(1);

    const persona = await requireUserPersonaForUser(owner.id);
    expect(persona.baseProfile.position).toBe('自営業');
  });

  it('同時に保存しても1件しか作られない', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        saveUserPersonaForUser(owner.id, input()),
      ),
    );

    expect(results.some((item) => item.status === 'fulfilled')).toBe(true);
    expect(await prisma.userPersona.count()).toBe(1);
  });
});

describe('編集（完了条件）', () => {
  beforeEach(async () => {
    await saveUserPersonaForUser(
      owner.id,
      input({ ngExpressions: ['絶対に'] }),
    );
  });

  it('渡した項目だけ変わる', async () => {
    const updated = await updateUserPersonaForUser(owner.id, {
      tone: { ...TONE, emojiLevel: 'none' },
    });

    expect(updated.tone.emojiLevel).toBe('none');
    // 他の項目は元のまま
    expect(updated.baseProfile).toEqual(BASE_PROFILE);
    expect(updated.values).toEqual(VALUES);
    expect(updated.ngExpressions).toEqual(['絶対に']);
  });

  it('NG表現を空にできる', async () => {
    const updated = await updateUserPersonaForUser(owner.id, {
      ngExpressions: [],
    });

    expect(updated.ngExpressions).toEqual([]);
  });

  it('何も渡さなければ変わらない', async () => {
    const before = await requireUserPersonaForUser(owner.id);
    const after = await updateUserPersonaForUser(owner.id, {});

    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  /**
   * **未登録から一部だけ渡して作らない。** 残りが空のまま保存され、
   * 記事生成が読めない値を掴む。
   */
  it('未登録のユーザーは編集できない', async () => {
    await expect(
      updateUserPersonaForUser(other.id, { tone: TONE }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.userPersona.count()).toBe(1);
  });

  it('壊れた形は保存されない', async () => {
    await expect(
      updateUserPersonaForUser(owner.id, {
        baseProfile: {
          ageRange: '30代',
        } as CreateUserPersonaInput['baseProfile'],
      }),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.invalidPersona });

    const persona = await requireUserPersonaForUser(owner.id);
    expect(persona.baseProfile).toEqual(BASE_PROFILE);
  });
});

describe('ユーザー別の分離（SPEC 14.1）', () => {
  beforeEach(async () => {
    await saveUserPersonaForUser(owner.id, input());
  });

  it('他人の人格は見えない', async () => {
    expect(await findUserPersonaForUser(other.id)).toBeNull();
  });

  it('他人が保存しても互いに影響しない', async () => {
    await saveUserPersonaForUser(
      other.id,
      input({ baseProfile: { ...BASE_PROFILE, firstPerson: '僕' } }),
    );

    expect(
      (await requireUserPersonaForUser(owner.id)).baseProfile.firstPerson,
    ).toBe('私');
    expect(
      (await requireUserPersonaForUser(other.id)).baseProfile.firstPerson,
    ).toBe('僕');
    expect(await prisma.userPersona.count()).toBe(2);
  });

  /** ユーザーを消したら人格も消える（`onDelete: Cascade`） */
  it('ユーザーを消すと人格も消える', async () => {
    await prisma.user.delete({ where: { id: owner.id } });

    expect(await prisma.userPersona.count()).toBe(0);
  });
});
