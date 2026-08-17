import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  listFactReviewWeeksForAdmin,
  recordFactReviewWeekForAdmin,
  summarizeFactReviewForAdmin,
} from '@/modules/content-generation';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 公開済み記事の抜き取り確認（2026-08-17 の決定）を**実PostgreSQLで**確かめる。
 *
 * ## なぜこの表が要るのか
 *
 * **`fact_issues` が空のとき、それが「誤りが無かった」のか
 * 「確かめていない」のかが分からない。**
 * これは `fact_issues` 自身が解いた問題と**同じ形**である。
 *
 * 守りたいのは3つ。
 *
 * 1. **0件で行を作らせない**（0件の行は「確認していない」と同じ意味になる）
 * 2. **見つけた数が確かめた数を超えない**
 * 3. **同じ週に入れ直したら上書きする**（週が二重にならない）
 */

let prisma: PrismaClient;
let adminId: string;

/** JST 2026-08-17（月） */
const WEEK = '2026-08-17';

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const admin = await createUser(prisma, { displayName: '管理者' });
  adminId = admin.id;
});

function record(overrides: Record<string, unknown> = {}) {
  return recordFactReviewWeekForAdmin({
    weekStart: WEEK,
    reviewedCount: 10,
    issueCount: 0,
    reviewedByUserId: adminId,
    ...overrides,
  });
}

describe('記録する', () => {
  /** **0件を記録できることが要点**（確かめて、無かった） */
  it('誤りが0件でも記録できる', async () => {
    const week = await record();

    expect(week).toMatchObject({
      weekStart: WEEK,
      reviewedCount: 10,
      issueCount: 0,
    });
  });

  /**
   * **日付がずれない**（Q-031）。`date` 型の列へ
   * 「JSTの00:00を表すUTCの瞬間」を渡すと1日前が保存される。
   */
  it('指定した週の月曜がそのまま入る', async () => {
    await record();

    const row = await prisma.factReviewWeek.findFirstOrThrow();

    expect(row.weekStart.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  /**
   * **0件で行を作らせない。** 作れると「確認していない」と
   * 同じ意味の行ができ、この表を作った理由が消える。
   */
  it('確かめた数が0なら断る', async () => {
    await expect(record({ reviewedCount: 0 })).rejects.toThrow(/1件以上/);
    expect(await prisma.factReviewWeek.count()).toBe(0);
  });

  it('見つけた数が確かめた数より多ければ断る', async () => {
    await expect(record({ reviewedCount: 5, issueCount: 6 })).rejects.toThrow(
      /多くなっています/,
    );
  });

  it('週の指定が読めなければ断る', async () => {
    await expect(record({ weekStart: '2026-02-30' })).rejects.toThrow(
      /週の指定/,
    );
  });

  /** **週が二重にならない。** 入れ直したら上書き */
  it('同じ週に入れ直すと上書きする', async () => {
    await record({ reviewedCount: 10, issueCount: 0 });
    const second = await record({ reviewedCount: 12, issueCount: 2 });

    expect(second.reviewedCount).toBe(12);
    expect(await prisma.factReviewWeek.count()).toBe(1);
  });

  /** **確かめた人を消しても記録は残る**（確かめた事実は消えない） */
  it('確かめた人を消しても残る', async () => {
    await record();
    await prisma.user.delete({ where: { id: adminId } });

    const row = await prisma.factReviewWeek.findFirstOrThrow();

    expect(row.reviewedByUserId).toBeNull();
  });
});

/**
 * **アプリを通らない経路でも作れない**（DBの CHECK）。
 */
describe('DBが止めること', () => {
  it('確かめた数が0の行は作れない', async () => {
    await expect(
      prisma.factReviewWeek.create({
        data: {
          weekStart: new Date('2026-08-17T00:00:00.000Z'),
          reviewedCount: 0,
          issueCount: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it('見つけた数が確かめた数を超える行は作れない', async () => {
    await expect(
      prisma.factReviewWeek.create({
        data: {
          weekStart: new Date('2026-08-17T00:00:00.000Z'),
          reviewedCount: 3,
          issueCount: 4,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('まとめる', () => {
  /** **「今週まだ確かめていない」を出すためのもの** */
  it('今週の確認があれば済みと出る', async () => {
    await record();

    const summary = await summarizeFactReviewForAdmin(
      new Date('2026-08-19T03:00:00.000Z'),
    );

    expect(summary.reviewedThisWeek).toBe(true);
    expect(summary.weeks).toBe(1);
    expect(summary.reviewedTotal).toBe(10);
  });

  it('先週までしか無ければ未確認と出る', async () => {
    await record({ weekStart: '2026-08-10' });

    const summary = await summarizeFactReviewForAdmin(
      new Date('2026-08-19T03:00:00.000Z'),
    );

    expect(summary.reviewedThisWeek).toBe(false);
    expect(summary.latest?.weekStart).toBe('2026-08-10');
  });

  /** **一度も無ければ 0 ではなく「無い」** */
  it('一度も無ければ latest は null', async () => {
    const summary = await summarizeFactReviewForAdmin();

    expect(summary.latest).toBeNull();
    expect(summary.reviewedThisWeek).toBe(false);
  });
});

/** **新しい週が先**（直近に何をしたかを先に見る） */
describe('一覧', () => {
  it('新しい順に並ぶ', async () => {
    await record({ weekStart: '2026-08-03' });
    await record({ weekStart: '2026-08-17' });
    await record({ weekStart: '2026-08-10' });

    const weeks = await listFactReviewWeeksForAdmin();

    expect(weeks.map((week) => week.weekStart)).toEqual([
      '2026-08-17',
      '2026-08-10',
      '2026-08-03',
    ]);
  });
});
