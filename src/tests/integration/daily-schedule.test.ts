import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  enqueueDailySchedule,
  runDailySchedule,
} from '@/app/api/jobs/run/schedule';
import { createBlogForUser } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 日次ジョブの積み込みを**実PostgreSQLで**確かめる（TASKS I-1）。
 *
 * **各タスクは「積む関数」まで作ったが、それを呼ぶ人がいなかった。**
 * cron は消化（`/api/jobs/run`）1本だけで、本番へ出しても検索データも
 * 集計もリンク確認も動き出さない状態だった（棚卸し・2026-08-12）。
 *
 * ここで確かめるのは**繋がったこと**と、**毎分呼ばれても重くならないこと。**
 */

let prisma: PrismaClient;

const NOW = new Date('2026-08-12T03:00:00.000Z'); // JST 12:00
const NEXT_DAY = new Date('2026-08-13T03:00:00.000Z');

async function activeUserWithBlog(): Promise<string> {
  const user = await createUser(prisma);
  const persona = await createPersona(prisma, user.id);

  await createBlogForUser(user.id, {
    personaId: persona.id,
    name: 'ブログ',
    slug: `blog-${user.id.slice(0, 8)}`,
    targetReader: '読者',
  });

  return user.id;
}

function jobTypes(): Promise<string[]> {
  return prisma.job
    .findMany({ select: { jobType: true }, orderBy: { jobType: 'asc' } })
    .then((rows) => rows.map((row) => row.jobType));
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
});

/**
 * **配るところ自体をジョブにする。** cron が毎分呼んでも、
 * その日の積み込みは1件しか積まれない（C-4）
 */
describe('積み込みジョブ', () => {
  it('その日の1件だけを積む', async () => {
    expect(await enqueueDailySchedule({ now: NOW })).toBe(true);
    expect(await enqueueDailySchedule({ now: NOW })).toBe(false);

    expect(
      await prisma.job.count({ where: { jobType: 'DAILY_SCHEDULE' } }),
    ).toBe(1);
  });

  /** **JSTの暦日で切る。** UTCで切ると日本の1日が2日にまたがる */
  it('日が変われば積まれる', async () => {
    await enqueueDailySchedule({ now: NOW });

    expect(await enqueueDailySchedule({ now: NEXT_DAY })).toBe(true);
    expect(
      await prisma.job.count({ where: { jobType: 'DAILY_SCHEDULE' } }),
    ).toBe(2);
  });
});

describe('利用者ごとの積み込み', () => {
  it('ACTIVE の利用者ぶんを積む', async () => {
    await activeUserWithBlog();

    const result = await runDailySchedule({ now: NOW });

    expect(result.users).toBe(1);
    expect(result.failed).toBe(0);
    // 検索データとインデックスは Search Console 未連携なので積まれない
    expect(result.queued.dailyAggregate).toBe(1);
    expect(result.queued.linkCheck).toBe(1);
    expect(await jobTypes()).toEqual(['LINK_CHECK', 'METRICS_AGGREGATE']);
  });

  /**
   * **招待しただけ・停止中・退会済みの人のブログを更新しない。**
   */
  it.each([
    { name: '招待しただけ', status: 'INVITED' as const },
    { name: '停止中', status: 'PAUSED' as const },
    { name: '退会済み', status: 'WITHDRAWN' as const },
  ])('$name は対象にしない', async ({ status }) => {
    const userId = await activeUserWithBlog();
    await prisma.user.update({ where: { id: userId }, data: { status } });

    const result = await runDailySchedule({ now: NOW });

    expect(result.users).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  /** **同じ日に二度走っても増えない**（それぞれの冪等キーが日付を持つ） */
  it('二度走っても積み直さない', async () => {
    await activeUserWithBlog();

    await runDailySchedule({ now: NOW });
    const second = await runDailySchedule({ now: NOW });

    expect(second.queued.dailyAggregate).toBe(0);
    expect(second.queued.linkCheck).toBe(0);
    expect(await prisma.job.count()).toBe(2);
  });

  it('日が変われば積み直す', async () => {
    await activeUserWithBlog();

    await runDailySchedule({ now: NOW });
    const next = await runDailySchedule({ now: NEXT_DAY });

    expect(next.queued.dailyAggregate).toBe(1);
    expect(next.queued.linkCheck).toBe(1);
  });

  /** **利用者が1人もいなくても落ちない**（実験開始前は普通にある） */
  it('利用者がいなくても落ちない', async () => {
    const result = await runDailySchedule({ now: NOW });

    expect(result).toMatchObject({ users: 0, failed: 0 });
  });

  /** ブログが無い利用者でも落ちない（登録直後） */
  it('ブログが無くても落ちない', async () => {
    await createUser(prisma);

    const result = await runDailySchedule({ now: NOW });

    expect(result.users).toBe(1);
    expect(result.failed).toBe(0);
    expect(await prisma.job.count()).toBe(1); // リンク確認は利用者単位
  });
});
