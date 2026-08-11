import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_ACTIVE_PERSONAS,
  PERSONA_ERROR_CODES,
  activatePersonaForUser,
  countActivePersonasForUser,
  createPersonaForUser,
  findPersonaForUser,
  listPersonasForUser,
  pausePersonaForUser,
  requirePersonaForUser,
  updatePersonaForUser,
} from '@/modules/personas';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 分身のCRUDを**実PostgreSQLで**確かめる（TASKS A-2-R-2）。
 *
 * **1ユーザーが複数持てること**が旧 `user_personas` との違い。
 * `user_id` が unique だった頃は条件に入れるだけで越境の余地が無かったが、
 * **複数件になったので `id` と `userId` の両方で絞る必要がある。**
 */

let prisma: PrismaClient;
let userId: string;

const NOW = new Date('2026-08-11T00:00:00.000Z');

function input(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: '節約の人',
    personaType: 'SELF',
    identity: {
      name: 'まこと',
      firstPerson: '私',
      background: '30代の会社員',
      tone: {
        style: 'やわらかい',
        emojiLevel: 'low',
        lineBreak: 'normal',
        politeness: 'です・ます',
      },
      values: { priorities: ['正確さ'], avoid: ['煽り'] },
      ngExpressions: ['絶対に儲かる'],
    },
    expertise: {
      fields: ['家計管理'],
      sources: ['総務省統計'],
      evaluationCriteria: ['実際に使ったか'],
    },
    audience: {
      ageRange: '30代',
      situation: '子育て中',
      knowledgeLevel: 'beginner',
      problems: ['固定費が下がらない'],
      searchIntents: ['格安SIM 比較'],
    },
    business: {
      revenuePolicy: '使ったものだけ紹介する',
      monthlyGoalYen: 30_000,
      kpis: ['成果件数'],
      exitCriteria: '3か月で表示回数が伸びなければ畳む',
    },
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
  const user = await createUser(prisma);
  userId = user.id;
});

describe('1ユーザーが複数持てる', () => {
  it('2体作れる', async () => {
    await createPersonaForUser(userId, input({ name: '節約の人' }));
    await createPersonaForUser(userId, input({ name: 'ガジェットの人' }));

    const list = await listPersonasForUser(userId);

    expect(list.map((persona) => persona.name)).toEqual([
      '節約の人',
      'ガジェットの人',
    ]);
  });

  /** **作った時点では `DRAFT`。** 作ることと使い始めることを分ける */
  it('作った直後は DRAFT', async () => {
    const persona = await createPersonaForUser(userId, input());

    expect(persona.status).toBe('DRAFT');
    expect(persona.activatedAt).toBeNull();
  });

  it('4つの jsonb がそのまま戻る', async () => {
    const persona = await createPersonaForUser(userId, input());

    expect(persona.identity.firstPerson).toBe('私');
    expect(persona.expertise.fields).toEqual(['家計管理']);
    expect(persona.audience.knowledgeLevel).toBe('beginner');
    expect(persona.business.exitCriteria).toContain('畳む');
  });

  it('壊れた入力は保存しない', async () => {
    await expect(
      createPersonaForUser(userId, input({ personaType: 'OTHER' })),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.invalidPersona });

    expect(await prisma.persona.count()).toBe(0);
  });
});

describe('更新', () => {
  it('渡した項目だけ変わる', async () => {
    const created = await createPersonaForUser(userId, input());

    const updated = await updatePersonaForUser(
      { userId, personaId: created.id },
      { name: '新しい名前' },
    );

    expect(updated.name).toBe('新しい名前');
    // **触っていない項目はそのまま**
    expect(updated.identity.firstPerson).toBe('私');
    expect(updated.expertise.fields).toEqual(['家計管理']);
  });
});

describe('使い始める', () => {
  it('ACTIVE になり activatedAt が入る', async () => {
    const created = await createPersonaForUser(userId, input());

    const activated = await activatePersonaForUser({
      userId,
      personaId: created.id,
      now: NOW,
    });

    expect(activated.status).toBe('ACTIVE');
    expect(activated.activatedAt).toEqual(NOW);
  });

  /** **二度押しをエラーにしない**（F-6 と同じ） */
  it('すでに ACTIVE なら何もせず成功する', async () => {
    const created = await createPersonaForUser(userId, input());
    await activatePersonaForUser({ userId, personaId: created.id, now: NOW });

    const again = await activatePersonaForUser({
      userId,
      personaId: created.id,
      now: new Date('2026-09-01T00:00:00.000Z'),
    });

    // **起点は動かさない。** 動くと段階解放の日数の数え方が変わる
    expect(again.activatedAt).toEqual(NOW);
  });

  /** **止めて再開しても起点は最初のまま** */
  it('再開しても activatedAt は最初のまま', async () => {
    const created = await createPersonaForUser(userId, input());
    await activatePersonaForUser({ userId, personaId: created.id, now: NOW });
    await pausePersonaForUser({ userId, personaId: created.id });

    const resumed = await activatePersonaForUser({
      userId,
      personaId: created.id,
      now: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(resumed.activatedAt).toEqual(NOW);
  });

  it(`同時に ACTIVE にできるのは ${MAX_ACTIVE_PERSONAS} 体まで`, async () => {
    const ids: string[] = [];

    for (let index = 0; index < MAX_ACTIVE_PERSONAS + 1; index += 1) {
      const created = await createPersonaForUser(
        userId,
        input({ name: `分身${index}` }),
      );
      ids.push(created.id);
    }

    for (const id of ids.slice(0, MAX_ACTIVE_PERSONAS)) {
      await activatePersonaForUser({ userId, personaId: id, now: NOW });
    }

    await expect(
      activatePersonaForUser({
        userId,
        personaId: ids[MAX_ACTIVE_PERSONAS] ?? '',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.invalidPersona });

    expect(await countActivePersonasForUser(userId)).toBe(MAX_ACTIVE_PERSONAS);
  });

  /** **止めれば枠が空く。** 上限に当たっても作業が詰まらない */
  it('止めると枠が空く', async () => {
    const ids: string[] = [];

    for (let index = 0; index < MAX_ACTIVE_PERSONAS + 1; index += 1) {
      const created = await createPersonaForUser(
        userId,
        input({ name: `分身${index}` }),
      );
      ids.push(created.id);
    }

    for (const id of ids.slice(0, MAX_ACTIVE_PERSONAS)) {
      await activatePersonaForUser({ userId, personaId: id, now: NOW });
    }

    await pausePersonaForUser({ userId, personaId: ids[0] ?? '' });

    const activated = await activatePersonaForUser({
      userId,
      personaId: ids[MAX_ACTIVE_PERSONAS] ?? '',
      now: NOW,
    });

    expect(activated.status).toBe('ACTIVE');
  });
});

/**
 * **習熟に合わせて開ける**（ROADMAP 5章、Q-034）。
 *
 * 起点は `users.activated_at`（ADMINが参加を認めた時刻）。
 * **登録時刻ではない** — 承認待ちの期間まで日数に含めると、
 * 使い始める前に2体目が開く。
 */
describe('段階解放', () => {
  async function joinedDaysAgo(days: number): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { activatedAt: new Date(NOW.getTime() - days * 86_400_000) },
    });
  }

  async function activateMany(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const created = await createPersonaForUser(
        userId,
        input({ name: `分身${index}` }),
      );
      await activatePersonaForUser({
        userId,
        personaId: created.id,
        now: NOW,
      });
    }
  }

  it.each([
    { days: 10, allowed: 1 },
    { days: 40, allowed: 2 },
    { days: 70, allowed: 3 },
  ])('参加から $days 日なら $allowed 体まで', async ({ days, allowed }) => {
    await joinedDaysAgo(days);
    await activateMany(allowed);

    const extra = await createPersonaForUser(userId, input({ name: '超過' }));

    await expect(
      activatePersonaForUser({ userId, personaId: extra.id, now: NOW }),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.invalidPersona });

    expect(await countActivePersonasForUser(userId)).toBe(allowed);
  });

  /** **断る理由に日数を出す。** 「上限です」だけでは、いつ開くのか分からない */
  it('断る文言に経過日数を含める', async () => {
    await joinedDaysAgo(10);
    await activateMany(1);

    const extra = await createPersonaForUser(userId, input({ name: '超過' }));

    try {
      await activatePersonaForUser({ userId, personaId: extra.id, now: NOW });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('10日');
    }
  });

  /**
   * **参加を認められる前は段階解放を効かせない。** ここで断ると
   * 「作れるのに使い始められない」状態になり、原因が画面から読めない
   */
  it('参加前でも使い始められる（上限3件は効く）', async () => {
    await activateMany(2);

    expect(await countActivePersonasForUser(userId)).toBe(2);
  });

  /** **下書きは作れる。** 上限に当たっても作業が止まらない */
  it('上限に当たっても下書きは作れる', async () => {
    await joinedDaysAgo(10);
    await activateMany(1);

    const created = await createPersonaForUser(userId, input({ name: '次の' }));

    expect(created.status).toBe('DRAFT');
  });
});

/**
 * **`user_id` が unique でなくなったので、`id` だけで引けない。**
 * 旧 `user_personas` は条件に `userId` を入れるだけで越境の余地が無かった。
 */
describe('他人の分身', () => {
  it('読めない', async () => {
    const created = await createPersonaForUser(userId, input());
    const other = await createUser(prisma);

    expect(
      await findPersonaForUser({
        userId: other.id,
        personaId: created.id,
      }),
    ).toBeNull();
  });

  it('404 になる（存在するとは伝えない）', async () => {
    const created = await createPersonaForUser(userId, input());
    const other = await createUser(prisma);

    await expect(
      requirePersonaForUser({ userId: other.id, personaId: created.id }),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.notFound });
  });

  it('更新できない', async () => {
    const created = await createPersonaForUser(userId, input());
    const other = await createUser(prisma);

    await expect(
      updatePersonaForUser(
        { userId: other.id, personaId: created.id },
        { name: '乗っ取り' },
      ),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.notFound });

    // **相手のデータが変わっていないこと**まで見る
    const row = await prisma.persona.findUnique({ where: { id: created.id } });

    expect(row?.name).toBe('節約の人');
  });

  it('使い始められない', async () => {
    const created = await createPersonaForUser(userId, input());
    const other = await createUser(prisma);

    await expect(
      activatePersonaForUser({
        userId: other.id,
        personaId: created.id,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: PERSONA_ERROR_CODES.notFound });
  });

  it('一覧に混ざらない', async () => {
    await createPersonaForUser(userId, input());
    const other = await createUser(prisma);

    expect(await listPersonasForUser(other.id)).toEqual([]);
  });
});
