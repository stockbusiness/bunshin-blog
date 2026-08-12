import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  acceptConsentForUser,
  findNotificationScheduleForUser,
  fromNotificationTimeColumn,
  saveNotificationScheduleForUser,
  syncOnboardingStatusForUser,
} from '@/modules/users';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * オンボーディングの受け付け（TASKS H-2b）を**実PostgreSQLで**確かめる。
 *
 * 見るのは **同意の時刻が動かないこと**、**通知の設定が往復すること**、
 * **`monitor_profiles` の行を勝手に作らないこと**。
 */

let prisma: PrismaClient;
let userId: string;

const FIRST = new Date('2026-08-12T01:00:00.000Z');
const LATER = new Date('2026-09-01T01:00:00.000Z');

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  // 同意していない状態から始める
  const user = await createUser(prisma, { consented: false });
  userId = user.id;
});

describe('同意', () => {
  it('規約とデータ利用を別々に記録する', async () => {
    await acceptConsentForUser({ userId, kind: 'TERMS', now: FIRST });

    const afterTerms = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { termsAcceptedAt: true, dataUseConsentAt: true },
    });

    expect(afterTerms.termsAcceptedAt).toEqual(FIRST);
    expect(afterTerms.dataUseConsentAt).toBeNull();

    await acceptConsentForUser({ userId, kind: 'DATA_USE', now: LATER });

    const afterBoth = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { termsAcceptedAt: true, dataUseConsentAt: true },
    });

    expect(afterBoth.dataUseConsentAt).toEqual(LATER);
  });

  /**
   * **一度入れた時刻を動かさない。** いつ同意したかは実験の記録で、
   * 二度目の操作で上書きすると「いつから使ってよかったか」が分からなくなる
   */
  it('二度目は時刻を動かさない', async () => {
    await acceptConsentForUser({ userId, kind: 'TERMS', now: FIRST });
    await acceptConsentForUser({ userId, kind: 'TERMS', now: LATER });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { termsAcceptedAt: true },
    });

    expect(row.termsAcceptedAt).toEqual(FIRST);
  });

  it('二度目もエラーにしない（冪等）', async () => {
    await acceptConsentForUser({ userId, kind: 'TERMS', now: FIRST });

    const again = await acceptConsentForUser({ userId, kind: 'TERMS' });

    expect(again.termsAcceptedAt).toEqual(FIRST);
  });
});

describe('通知の設定', () => {
  /** **段9まで来ていない人に空の行を作らない** */
  it('保存するまで monitor_profiles の行はできない', async () => {
    expect(await prisma.monitorProfile.count({ where: { userId } })).toBe(0);
    expect(await findNotificationScheduleForUser(userId)).toBeNull();
  });

  it('保存すると行ができ、そのまま戻る', async () => {
    await saveNotificationScheduleForUser(userId, {
      days: [5, 1, 3],
      time: '07:30',
    });

    const saved = await findNotificationScheduleForUser(userId);

    expect(saved?.days).toEqual([1, 3, 5]);
    // **JSTの壁掛け時計。** UTCへずらさない
    expect(fromNotificationTimeColumn(saved?.time ?? new Date(0))).toBe(
      '07:30',
    );
  });

  it('二度保存しても行は増えない', async () => {
    await saveNotificationScheduleForUser(userId, { days: [1], time: '07:00' });
    await saveNotificationScheduleForUser(userId, { days: [2], time: '08:00' });

    expect(await prisma.monitorProfile.count({ where: { userId } })).toBe(1);
    expect((await findNotificationScheduleForUser(userId))?.days).toEqual([2]);
  });

  it('壊れた入力は保存しない', async () => {
    await expect(
      saveNotificationScheduleForUser(userId, { days: [], time: '07:00' }),
    ).rejects.toMatchObject({ status: 422 });

    expect(await prisma.monitorProfile.count({ where: { userId } })).toBe(0);
  });
});

/** **導いた値を書くだけ**（正は `resolveOnboardingProgress`・B-7 が読む） */
describe('進み具合の書き戻し', () => {
  it('行が無ければ何もしない', async () => {
    await syncOnboardingStatusForUser({ userId, status: 'COMPLETED' });

    expect(await prisma.monitorProfile.count({ where: { userId } })).toBe(0);
  });

  it('行があれば書き換える', async () => {
    await saveNotificationScheduleForUser(userId, { days: [1], time: '07:00' });

    await syncOnboardingStatusForUser({ userId, status: 'COMPLETED' });

    const row = await prisma.monitorProfile.findUniqueOrThrow({
      where: { userId },
      select: { onboardingStatus: true },
    });

    expect(row.onboardingStatus).toBe('COMPLETED');
  });
});
