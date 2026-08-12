import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  MATURE_AFTER_DAYS,
  MIN_JUDGED_ARTICLES,
  reviewPublishPaceForBlog,
} from '@/modules/analytics';
import { listAuditLogsForAdmin } from '@/modules/audit';
import { createBlogForUser, requireBlogForUser } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * 公開ペースの見直しを**実PostgreSQLで**確かめる（TASKS G-8b、W-8）。
 *
 * **母数の作り方**がこの試験の中心。
 *
 * - 公開から14日未満は数えない（**出したばかりで載っていないのは当たり前**）
 * - 下書きのままは数えない
 * - **`indexed` が `NULL` の記事は数えない**（G-3 が「分からない」を
 *   `false` に倒していないので、ここで倒すと**取得に失敗しただけの
 *   ブログが停止される**）
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let planId: string;
let sequenceNo = 0;

const NOW = new Date('2026-08-12T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

/**
 * 公開済みの記事を1本作る。
 *
 * @param verdicts 日付の古い順に入れるインデックス判定。`null` は
 *   「Google が判断を返さなかった日」（G-3 は書かないので行も作らない）
 */
async function article(params: {
  publishedAt: Date | null;
  verdicts?: (boolean | null)[];
}): Promise<void> {
  sequenceNo += 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: planId,
      blogId,
      sequenceNo,
      contentType: 'INFORMATIONAL',
      title: `記事${String(sequenceNo)}`,
      primaryKeyword: `キーワード${String(sequenceNo)}`,
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: sequenceNo,
      status: 'PUBLISHED',
    },
    select: { id: true },
  });

  await prisma.wordpressPost.create({
    data: {
      blogId,
      contentItemId: item.id,
      wpPostId: 1_000 + sequenceNo,
      wpStatus: params.publishedAt === null ? 'DRAFT' : 'PUBLISH',
      postedAt: params.publishedAt ?? daysAgo(30),
      publishedAt: params.publishedAt,
      lastContentHash: 'x'.repeat(64),
    },
  });

  const verdicts = params.verdicts ?? [];

  for (const [index, verdict] of verdicts.entries()) {
    if (verdict === null) {
      // **書かない**（G-3 と同じ）。行が無いことが「分からない」
      continue;
    }

    await prisma.metricDaily.create({
      data: {
        blogId,
        contentItemId: item.id,
        metricDate: new Date(
          Date.UTC(2026, 7, 1 + index), // 8月1日から1日ずつ
        ),
        indexed: verdict,
      },
    });
  }
}

/** 判定に足りる本数の記事を作る */
async function articles(count: number, indexed: boolean): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await article({
      publishedAt: daysAgo(MATURE_AFTER_DAYS + 1),
      verdicts: [indexed],
    });
  }
}

function currentCap(): Promise<number> {
  return requireBlogForUser({ userId, blogId }).then(
    (blog) => blog.articleRatio.weeklyPublishCap,
  );
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
  sequenceNo = 0;

  const user = await createUser(prisma);
  userId = user.id;

  const persona = await createPersona(prisma, userId);
  const blog = await createBlogForUser(userId, {
    personaId: persona.id,
    name: 'ブログ',
    slug: 'blog',
    targetReader: '読者',
  });
  blogId = blog.id;

  const plan = await prisma.contentPlan.create({
    data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });
  planId = plan.id;
});

describe('上限を上げる', () => {
  it('80%以上なら +1 して記録が残る', async () => {
    await articles(8, true);
    await articles(2, false);

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result).toMatchObject({
      decision: 'RAISE',
      judged: 10,
      indexed: 8,
      previousCap: 4,
      nextCap: 5,
    });
    expect(await currentCap()).toBe(5);

    const [log] = await listAuditLogsForAdmin({ entityType: 'blog' });

    expect(log).toMatchObject({
      // **人が押した操作ではない**
      actorUserId: null,
      action: 'PUBLISH_CAP_ADJUSTED',
      entityId: blogId,
    });
    // **数えた元も残す。** 率だけだと 5本中4本か100本中80本かが分からない
    expect(log?.metadata).toMatchObject({ from: 4, to: 5, judged: 10 });
  });
});

describe('公開を止める', () => {
  it('50%未満なら0本にする', async () => {
    await articles(4, true);
    await articles(6, false);

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.decision).toBe('STOP');
    expect(await currentCap()).toBe(0);
  });

  /** 0本は利用者が設定できない値（G-8a）。**専用の経路だけが書ける** */
  it('止めた後も読み出せる', async () => {
    await articles(10, false);
    await reviewPublishPaceForBlog({ blogId, now: NOW });

    const blog = await requireBlogForUser({ userId, blogId });

    expect(blog.articleRatio.weeklyPublishCap).toBe(0);
    // **算出値を消さない**（Q-011）
    expect(blog.articleRatio.revenue).toBeGreaterThan(0);
  });
});

/**
 * **出したばかりの記事は、まだ載っていなくて当たり前。**
 * 含めると「たくさん出したブログほどインデックス率が低い」ことになる
 */
describe('母数に入れない記事', () => {
  it('公開から14日未満は数えない', async () => {
    await articles(MIN_JUDGED_ARTICLES, true);

    // 載っていない新しい記事をたくさん足しても、判定は変わらない
    for (let index = 0; index < 20; index += 1) {
      await article({
        publishedAt: daysAgo(MATURE_AFTER_DAYS - 1),
        verdicts: [false],
      });
    }

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.judged).toBe(MIN_JUDGED_ARTICLES);
    expect(result.indexed).toBe(MIN_JUDGED_ARTICLES);
  });

  it('下書きのままは数えない', async () => {
    await articles(MIN_JUDGED_ARTICLES, true);

    for (let index = 0; index < 20; index += 1) {
      await article({ publishedAt: null, verdicts: [false] });
    }

    expect((await reviewPublishPaceForBlog({ blogId, now: NOW })).judged).toBe(
      MIN_JUDGED_ARTICLES,
    );
  });

  /**
   * **ここが要。** 「分からない」を「載っていない」に倒すと、
   * 取得に失敗しただけのブログが停止される
   */
  it('判定の無い記事は数えない', async () => {
    await articles(MIN_JUDGED_ARTICLES, true);

    for (let index = 0; index < 20; index += 1) {
      await article({
        publishedAt: daysAgo(MATURE_AFTER_DAYS + 1),
        verdicts: [null],
      });
    }

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.judged).toBe(MIN_JUDGED_ARTICLES);
    expect(result.decision).toBe('RAISE');
  });

  /** **記事ごとに最も新しい判定を使う。** 古い日まで数えると重複する */
  it('同じ記事の古い判定は数えない', async () => {
    for (let index = 0; index < MIN_JUDGED_ARTICLES; index += 1) {
      await article({
        publishedAt: daysAgo(MATURE_AFTER_DAYS + 1),
        // 最初は載っていなかったが、いまは載っている
        verdicts: [false, false, true],
      });
    }

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.judged).toBe(MIN_JUDGED_ARTICLES);
    expect(result.indexed).toBe(MIN_JUDGED_ARTICLES);
  });
});

describe('動かさないとき', () => {
  it('判定のある記事が少なければ何も書かない', async () => {
    await articles(MIN_JUDGED_ARTICLES - 1, false);

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.decision).toBe('NOT_ENOUGH_DATA');
    expect(await currentCap()).toBe(4);
    expect(await listAuditLogsForAdmin({ entityType: 'blog' })).toEqual([]);
  });

  /**
   * **変わらないなら書かない。** 2週間ごとに同じ値を書き直すと、
   * 監査ログが「変わらなかった記録」で埋まり、変わった回が埋もれる
   */
  it('上限が変わらないなら記録も残さない', async () => {
    await articles(6, true);
    await articles(4, false);

    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.decision).toBe('KEEP');
    expect(await listAuditLogsForAdmin({ entityType: 'blog' })).toEqual([]);
  });

  it('記事が1本も無くても落ちない', async () => {
    const result = await reviewPublishPaceForBlog({ blogId, now: NOW });

    expect(result.decision).toBe('NOT_ENOUGH_DATA');
    expect(result.judged).toBe(0);
  });
});
