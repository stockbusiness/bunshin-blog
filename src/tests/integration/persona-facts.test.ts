import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  createPersonaFactForUser,
  deletePersonaFactForUser,
  findPersonaFactForUser,
  listPersonaFactsForUser,
  requirePersonaFactForUser,
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

let prisma: PrismaClient;
let owner: { id: string };
let other: { id: string };
let blog1: string;
let blog2: string;
let otherBlog: string;
let persona1: string;
let persona2: string;
let otherPersona: string;

function input(
  overrides: Partial<CreatePersonaFactInput> = {},
): CreatePersonaFactInput {
  return {
    personaId: persona1,
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

  persona1 = (await createPersona(prisma, owner.id)).id;
  persona2 = (await createPersona(prisma, owner.id)).id;
  otherPersona = (await createPersona(prisma, other.id)).id;

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
      personaId: persona2,
      name: 'ブログ2',
      slug: 'mine-2',
      targetReader: '読者',
      slotNumber: 2,
    })
  ).id;
  otherBlog = (
    await createBlogForUser(other.id, {
      personaId: otherPersona,
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

/**
 * **記憶は分身に溜まる**（A-2-R-4）。媒体ではない。
 *
 * A-2-R-4 より前は「ブログ固有の事実 + 全ブログ共通の事実」だったが、
 * 分身の媒体が1件になったので「共通」と「固有」を分ける意味が無くなった。
 */
describe('分身との紐付け', () => {
  it('分身に紐づいて保存される', async () => {
    const fact = await createPersonaFactForUser(owner.id, input());

    expect(fact.personaId).toBe(persona1);
  });

  /** 他人の分身に記憶を足されると、その分身の記事生成へ混ざる */
  it('他人の分身には紐づけられない', async () => {
    await expect(
      createPersonaFactForUser(owner.id, input({ personaId: otherPersona })),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.personaFact.count()).toBe(0);
  });

  it('存在しない分身には紐づけられない', async () => {
    await expect(
      createPersonaFactForUser(
        owner.id,
        input({ personaId: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * 記事生成（E-8）が使う形。**媒体から書き手を辿る** —
   * ブログと分身は1対1なので、`blogId` を渡せばその分身の記憶が決まる
   */
  it('ブログを渡すと、その媒体を書く分身の記憶だけを返す', async () => {
    await createPersonaFactForUser(
      owner.id,
      input({ content: '分身1の記憶', personaId: persona1 }),
    );
    await createPersonaFactForUser(
      owner.id,
      input({ content: '分身2の記憶', personaId: persona2 }),
    );

    expect(
      (await listPersonaFactsForUser(owner.id, { blogId: blog1 })).map(
        (fact) => fact.content,
      ),
    ).toEqual(['分身1の記憶']);

    // **媒体が違えば書き手が違う。** 混ざらないことまで見る
    expect(
      (await listPersonaFactsForUser(owner.id, { blogId: blog2 })).map(
        (fact) => fact.content,
      ),
    ).toEqual(['分身2の記憶']);
  });

  it('他人のブログを渡すと404', async () => {
    await expect(
      listPersonaFactsForUser(owner.id, { blogId: otherBlog }),
    ).rejects.toMatchObject({ status: 404 });
  });

  /** 絞らなければ、その利用者の全ての分身の記憶が出る */
  it('ブログを渡さなければ全ての分身の記憶を返す', async () => {
    await createPersonaFactForUser(
      owner.id,
      input({ content: '分身1の記憶', personaId: persona1 }),
    );
    await createPersonaFactForUser(
      owner.id,
      input({ content: '分身2の記憶', personaId: persona2 }),
    );

    const facts = await listPersonaFactsForUser(owner.id);

    expect(facts.map((fact) => fact.content).sort()).toEqual(
      ['分身1の記憶', '分身2の記憶'].sort(),
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
    await createPersonaFactForUser(
      other.id,
      input({ content: '他人の事実', personaId: otherPersona }),
    );

    const facts = await listPersonaFactsForUser(owner.id);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.personaId).toBe(persona1);
  });
});

/**
 * **消しても掃除する相手がもう無い**（A-2-R-2e）。
 *
 * D-6 では `blog_persona_settings.allowed_experiences` から外していたが、
 * その列を使うのをやめた。**記憶は分身に溜まり**（A-2-R-2-schema）、
 * その分身の媒体は1つ（A-2-R-2c）なので、媒体ごとに選び直す意味が無い。
 */
describe('事実の削除', () => {
  it('消すと一覧から消える', async () => {
    const factId = (await createPersonaFactForUser(owner.id, input())).id;

    await deletePersonaFactForUser({ userId: owner.id, factId });

    expect(await prisma.personaFact.count({ where: { id: factId } })).toBe(0);
  });

  it('他人の事実は消せない', async () => {
    const theirFact = (
      await createPersonaFactForUser(
        other.id,
        input({ personaId: otherPersona }),
      )
    ).id;

    await expect(
      deletePersonaFactForUser({ userId: owner.id, factId: theirFact }),
    ).rejects.toMatchObject({ status: 404 });

    // **相手のデータが消えていないこと**まで見る
    expect(await prisma.personaFact.count({ where: { id: theirFact } })).toBe(
      1,
    );
  });
});
