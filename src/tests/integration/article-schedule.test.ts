import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { enqueueArticleGenerationForUser } from '@/app/api/jobs/run/article-schedule';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 記事生成の積み込みを**実PostgreSQLで**確かめる（TASKS I-4、SPEC 9.2）。
 *
 * **E-10 は「1本生成する関数」まで作ったが、それを呼ぶ人がいなかった**
 * （棚卸し・2026-08-12。I-1・I-2 と同じ穴）。構成表は作られても、
 * **記事は1本も書かれない**状態だった。
 *
 * ここで確かめるのは、**公開する曜日にだけ積むこと**（C-9）と、
 * **その週まで**の記事しか書き始めないこと（週の上限）。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

/** 2026-08-12（水）12:00 JST */
const WEDNESDAY = new Date('2026-08-12T03:00:00.000Z');
/** 2026-08-13（木）12:00 JST */
const THURSDAY = new Date('2026-08-13T03:00:00.000Z');
/** 公開開始日。WEDNESDAY と同じ週（1週目） */
const LAUNCH = new Date('2026-08-10T00:00:00.000Z');

async function setSchedule(params: {
  weekdays: number[];
  launchDate?: Date | null;
  status?: 'SETUP' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
}): Promise<void> {
  await prisma.blog.update({
    where: { id: blogId },
    data: {
      publishWeekdays: params.weekdays,
      launchDate: params.launchDate === undefined ? LAUNCH : params.launchDate,
      status: params.status ?? 'ACTIVE',
    },
  });
}

/**
 * 構成表に記事を1本足す。
 *
 * `plannedPublishWeek` は `assignPublishOrder` が割り当てる値（C-9）。
 * **上限はここで詰める時点で効いている**ので、積み込み側では数え直さない。
 */
async function addItem(params: {
  sequenceNo: number;
  week: number | null;
  status?: 'PLANNED' | 'GENERATING' | 'READY_FOR_REVIEW' | 'POSTED';
}): Promise<string> {
  const plan = await prisma.contentPlan.upsert({
    where: {
      blogId_planType_version: { blogId, planType: 'INITIAL', version: 1 },
    },
    update: {},
    create: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: params.sequenceNo,
      contentType: 'INFORMATIONAL',
      title: `記事${params.sequenceNo}`,
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: params.sequenceNo,
      plannedPublishWeek: params.week,
      status: params.status ?? 'PLANNED',
    },
    select: { id: true },
  });

  return item.id;
}

function queuedTargets(): Promise<(string | null)[]> {
  return prisma.job
    .findMany({
      where: { jobType: 'ARTICLE_GENERATION' },
      select: { targetId: true },
    })
    .then((rows) => rows.map((row) => row.targetId));
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
  const blog = await createBlog(prisma, user.id, { name: 'ブログ' });
  blogId = blog.id;
});

describe('公開する曜日にだけ積む（C-9）', () => {
  it('公開日なら1本積む', async () => {
    await setSchedule({ weekdays: [3] }); // 水曜
    const itemId = await addItem({ sequenceNo: 1, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result).toMatchObject({ blogs: 1, queued: 1, failed: 0 });
    expect(await queuedTargets()).toEqual([itemId]);
  });

  it('公開日でなければ積まない', async () => {
    await setSchedule({ weekdays: [3] }); // 水曜だけ
    await addItem({ sequenceNo: 1, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: THURSDAY,
    });

    expect(result).toMatchObject({ blogs: 0, queued: 0 });
    expect(await prisma.job.count()).toBe(0);
  });

  /**
   * **UTCで曜日を見ると、日本の朝が前日として判定される**（F-3b と同じ）。
   * JSTの水曜0時はUTCでは火曜15時
   */
  it('JSTで曜日を見る', async () => {
    await setSchedule({ weekdays: [3] }); // 水曜
    await addItem({ sequenceNo: 1, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: new Date('2026-08-11T15:00:00.000Z'), // 2026-08-12(水) 00:00 JST
    });

    expect(result.queued).toBe(1);
  });
});

describe('その週までの記事だけを書き始める', () => {
  it('先の週の記事は積まない', async () => {
    await setSchedule({ weekdays: [3] });
    await addItem({ sequenceNo: 1, week: 2 }); // まだ来ていない週

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result.queued).toBe(0);
  });

  /** **いつ出すか決まっていないものを先に書くと、構成表の順序が壊れる** */
  it('週が未割り当ての記事は積まない', async () => {
    await setSchedule({ weekdays: [3] });
    await addItem({ sequenceNo: 1, week: null });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result.queued).toBe(0);
  });

  /** **1日1本だけ。** まとめて積むと、AIの呼び出しが一度に走る */
  it('溜まっていても1本だけ積む', async () => {
    await setSchedule({ weekdays: [3] });
    const first = await addItem({ sequenceNo: 1, week: 1 });
    await addItem({ sequenceNo: 2, week: 1 });
    await addItem({ sequenceNo: 3, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result.queued).toBe(1);
    // **公開順に書く**（収益記事が先行する並びをそのまま使う）
    expect(await queuedTargets()).toEqual([first]);
  });

  it('生成済み・生成中の記事は対象にしない', async () => {
    await setSchedule({ weekdays: [3] });
    await addItem({ sequenceNo: 1, week: 1, status: 'GENERATING' });
    await addItem({ sequenceNo: 2, week: 1, status: 'READY_FOR_REVIEW' });
    const planned = await addItem({ sequenceNo: 3, week: 1 });

    await enqueueArticleGenerationForUser(userId, { now: WEDNESDAY });

    expect(await queuedTargets()).toEqual([planned]);
  });
});

describe('対象にしないブログ', () => {
  /** 準備中のブログの記事を書かない */
  it.each([
    { name: '準備中', status: 'SETUP' as const },
    { name: '停止中', status: 'PAUSED' as const },
    { name: '閉じた', status: 'CLOSED' as const },
  ])('$name ブログは積まない', async ({ status }) => {
    await setSchedule({ weekdays: [3], status });
    await addItem({ sequenceNo: 1, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result).toMatchObject({ blogs: 0, queued: 0 });
  });

  /**
   * **週の起点が決まっていない。** 「いま何週目か」を推測で決めると
   * 構成表の順序が壊れる
   */
  it('公開開始日が無いブログは積まない', async () => {
    await setSchedule({ weekdays: [3], launchDate: null });
    await addItem({ sequenceNo: 1, week: 1 });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result).toMatchObject({ blogs: 0, queued: 0 });
  });
});

/** **冪等キーは記事IDそのもの。** 同じ記事を二度は書かない */
describe('二度積まない', () => {
  it('同じ日に二度走っても増えない', async () => {
    await setSchedule({ weekdays: [3] });
    await addItem({ sequenceNo: 1, week: 1 });

    await enqueueArticleGenerationForUser(userId, { now: WEDNESDAY });
    const second = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(second.queued).toBe(0);
    expect(await prisma.job.count()).toBe(1);
  });

  /**
   * **次の公開日には次の記事へ進む** — 状態を進めるのは生成した側なので、
   * まだ `PLANNED` のままなら同じ記事が先頭に残る（積み直されない）
   */
  it('翌週の公開日でも同じ記事は積み直さない', async () => {
    await setSchedule({ weekdays: [3] });
    await addItem({ sequenceNo: 1, week: 1 });

    await enqueueArticleGenerationForUser(userId, { now: WEDNESDAY });
    const nextWeek = await enqueueArticleGenerationForUser(userId, {
      now: new Date(WEDNESDAY.getTime() + 7 * 86_400_000),
    });

    expect(nextWeek.queued).toBe(0);
    expect(await prisma.job.count()).toBe(1);
  });
});

/** ブログが無い・記事が無い利用者でも落ちない（登録直後） */
describe('落ちない', () => {
  it('記事が無くても落ちない', async () => {
    await setSchedule({ weekdays: [3] });

    const result = await enqueueArticleGenerationForUser(userId, {
      now: WEDNESDAY,
    });

    expect(result).toMatchObject({ blogs: 1, queued: 0, failed: 0 });
  });

  it('ブログが無くても落ちない', async () => {
    const other = await createUser(prisma);

    const result = await enqueueArticleGenerationForUser(other.id, {
      now: WEDNESDAY,
    });

    expect(result).toMatchObject({ blogs: 0, queued: 0, failed: 0 });
  });
});
