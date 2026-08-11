import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  WEEKLY_RESULT_ERROR_CODES,
  listWeeklyResultsForUser,
  saveWeeklyResultForUser,
} from '@/modules/analytics';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 手動の収益入力を**実PostgreSQLで**確かめる（TASKS G-5、SPEC 6.1）。
 *
 * 完了条件は「成果件数と報酬額のみ入力。**0件を1操作で記録できる**」。
 *
 * **「0件」と「未報告」を分けられることが要点。** 分けられないと、
 * あとから「成果が無かった」のか「報告されなかった」のかが読めない。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

/** JST 2026-08-12（水）。その週の月曜は 2026-08-10 */
const NOW = new Date('2026-08-12T03:00:00.000Z');

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
  const blog = await createBlog(prisma, userId);
  blogId = blog.id;
});

/**
 * **保存される日付が指定した暦日と一致すること**（OPEN_QUESTIONS Q-031）。
 *
 * `metric_date` は `date` 型で、時刻を持たない。ここへ
 * 「JSTの00:00を表すUTCの瞬間」を渡すと**UTCの日付部分が取られ、
 * 1日前が保存される。** PostgreSQL が実際に何を持っているかで確かめる。
 */
describe('保存される日付', () => {
  it('指定した週の月曜がそのまま入る', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 1, revenueYen: 100 },
    );

    const rows = await prisma.$queryRawUnsafe<{ metric_date: string }[]>(
      'select metric_date::text as metric_date from metrics_daily',
    );

    expect(rows[0]?.metric_date).toBe('2026-08-10');
  });

  it('読み出した週も同じ日付で返る', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 1, revenueYen: 100 },
    );

    const rows = await listWeeklyResultsForUser(
      { userId, blogId },
      { weeks: 1, now: NOW },
    );

    expect(rows[0]).toMatchObject({
      weekStart: '2026-08-10',
      reported: true,
      conversions: 1,
    });
  });
});

describe('0件を1操作で記録できる（完了条件）', () => {
  it('0件0円が保存される', async () => {
    const result = await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 0, revenueYen: 0 },
    );

    expect(result).toMatchObject({ conversions: 0, revenueYen: 0 });
  });

  /** **これが分けられないと記録の穴を読めない** */
  it('0件の報告と未報告を区別できる', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 0, revenueYen: 0 },
    );

    const rows = await listWeeklyResultsForUser(
      { userId, blogId },
      { weeks: 3, now: NOW },
    );

    // 今週は報告済み（0件）、前の2週は未報告
    expect(rows[0]).toMatchObject({
      weekStart: '2026-08-10',
      conversions: 0,
      reported: true,
    });
    expect(rows[1]?.reported).toBe(false);
    expect(rows[2]?.reported).toBe(false);
  });
});

describe('週の単位（JSTの月曜始まり）', () => {
  it('週の途中に入れても同じ行になる', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 1, revenueYen: 1_000 },
    );
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 3, revenueYen: 4_500 },
    );

    // **上書きする。** 週の途中で確定していない値を入れておき、あとで直せる
    expect(await prisma.metricDaily.count()).toBe(1);

    const rows = await listWeeklyResultsForUser(
      { userId, blogId },
      { weeks: 1, now: NOW },
    );

    expect(rows[0]).toMatchObject({ conversions: 3, revenueYen: 4_500 });
  });

  it('別の週は別の行になる', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 1, revenueYen: 1_000 },
    );
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-03' },
      { conversions: 2, revenueYen: 2_000 },
    );

    expect(await prisma.metricDaily.count()).toBe(2);

    const rows = await listWeeklyResultsForUser(
      { userId, blogId },
      { weeks: 2, now: NOW },
    );

    expect(rows.map((row) => row.conversions)).toEqual([1, 2]);
  });

  /** **ブログ単位で記録する**（記事ごとの分解はモニターにさせない） */
  it('記事に紐づけない', async () => {
    await saveWeeklyResultForUser(
      { userId, blogId, weekStart: '2026-08-10' },
      { conversions: 1, revenueYen: 1_000 },
    );

    const row = await prisma.metricDaily.findFirst({
      select: { contentItemId: true },
    });

    expect(row?.contentItemId).toBeNull();
  });
});

describe('受け付けない入力', () => {
  it('0件なのに報酬があれば落とす', async () => {
    await expect(
      saveWeeklyResultForUser(
        { userId, blogId, weekStart: '2026-08-10' },
        { conversions: 0, revenueYen: 500 },
      ),
    ).rejects.toMatchObject({ code: WEEKLY_RESULT_ERROR_CODES.invalidInput });

    expect(await prisma.metricDaily.count()).toBe(0);
  });

  it('負の数を落とす', async () => {
    await expect(
      saveWeeklyResultForUser(
        { userId, blogId, weekStart: '2026-08-10' },
        { conversions: -1, revenueYen: 0 },
      ),
    ).rejects.toMatchObject({ code: WEEKLY_RESULT_ERROR_CODES.invalidInput });
  });
});

describe('他人のブログには記録できない', () => {
  it('他人のブログIDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      saveWeeklyResultForUser(
        { userId, blogId: otherBlog.id, weekStart: '2026-08-10' },
        { conversions: 1, revenueYen: 1_000 },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.metricDaily.count()).toBe(0);
  });

  it('一覧も他人のブログでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      listWeeklyResultsForUser({ userId, blogId: otherBlog.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
