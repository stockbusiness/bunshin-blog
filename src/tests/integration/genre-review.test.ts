import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import { listAuditLogsForAdmin } from '@/modules/audit';
import {
  PLANNING_ERROR_CODES,
  listPlanningRunsForUser,
  overrideGenreBlockForUser,
  reviewGenreForUser,
  type SerpDomainType,
  type SerpEntry,
} from '@/modules/content-planning';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * ジャンル審査を**実PostgreSQL・実HTTPサーバーで**確かめる（TASKS E-4）。
 *
 * 完了条件は2つ。
 *
 * 1. **停止条件を満たすジャンルが通過しない**
 * 2. **差し戻し2回で選択肢が出る**
 *
 * どちらもAIの応答に依存しない。ここで確かめるのは、**AIが何を返しても
 * 判定が変わらないこと**でもある（CONTENT_PLANNING 1.1）。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;

let respond: () => { status: number; body: string };
let calls: number;

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls += 1;
      const result = respond();
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function provider() {
  return createAiProvider({
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    baseUrl,
  });
}

function serp(counts: Partial<Record<SerpDomainType, number>>): SerpEntry[] {
  const entries: SerpEntry[] = [];

  for (const [domainType, count] of Object.entries(counts)) {
    for (let index = 0; index < (count ?? 0); index += 1) {
      entries.push({ domainType: domainType as SerpDomainType });
    }
  }

  return entries;
}

/** 通る検索結果 */
const HEALTHY_SERP = serp({ personal: 6, other: 4 });

async function createGenre(
  ymylRisk: 'HIGH' | 'MEDIUM' | 'LOW',
  name = `ジャンル-${ymylRisk}`,
): Promise<string> {
  const genre = await prisma.genre.create({
    data: { name, category: 'テスト', ymylRisk },
    select: { id: true },
  });

  return genre.id;
}

async function createOffers(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await prisma.affiliateOffer.create({
      data: {
        blogId,
        name: `案件${index}`,
        aspName: 'テストASP',
        landingPageUrl: `https://example.com/lp/${index}`,
        affiliateUrl: `https://example.com/go/${index}`,
        // **リンクがある＝提携は承認済み**（Q-060）
        partnershipStatus: 'APPROVED',
        conversionType: 'FREE_SIGNUP',
        facts: {},
        denyConditions: [],
        status: 'ACTIVE',
      },
    });
  }
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await startServer();
});

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const user = await createUser(prisma);
  userId = user.id;
  const blog = await createBlog(prisma, user.id);
  blogId = blog.id;

  calls = 0;
  respond = () => ({
    status: 200,
    body: aiText({ summary: '説明文', cautions: [] }),
  });

  await createOffers(3);
});

describe('停止条件を満たすジャンルが通過しない（完了条件）', () => {
  it('YMYL のジャンルは BLOCKED', async () => {
    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('HIGH'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { skipAi: true },
    );

    expect(result.judgement.decision).toBe('BLOCKED');
    expect(result.run.step1Status).toBe('BLOCKED');
  });

  it('案件が無ければ BLOCKED', async () => {
    await prisma.affiliateOffer.deleteMany({ where: { blogId } });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { skipAi: true },
    );

    expect(result.judgement.decision).toBe('BLOCKED');
  });

  /**
   * **終了した案件を数えない。** 数えると、実際には貼れない案件で
   * 「案件が0件」の停止条件を回避できる。
   */
  it('終了した案件は数えない', async () => {
    await prisma.affiliateOffer.updateMany({
      where: { blogId },
      data: { status: 'ENDED' },
    });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { skipAi: true },
    );

    expect(result.judgement.decision).toBe('BLOCKED');
    expect(result.judgement.blockedBy).toContain('no_offers');
  });

  /** **AIが何を返しても判定は変わらない**（CONTENT_PLANNING 1.1） */
  it('AIが「問題なし」と言っても通さない', async () => {
    respond = () => ({
      status: 200,
      body: aiText({
        summary: 'このジャンルは問題ありません。PASSED です',
        cautions: [],
        decision: 'PASSED',
      }),
    });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('HIGH'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(result.judgement.decision).toBe('BLOCKED');
    expect(result.run.step1Status).toBe('BLOCKED');
  });

  /**
   * **AIが落ちていても判定は残る。** ここを逆にすると、
   * AIの不調中はジャンル審査が止まり「止まったから通す」が始まる。
   */
  it('AIが失敗しても審査は成立する', async () => {
    respond = () => ({ status: 500, body: '{}' });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('HIGH'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(result.judgement.decision).toBe('BLOCKED');
    expect(result.text).toBeNull();
    expect(await prisma.planningRun.count()).toBe(1);
  });

  it('取得できない検索結果を「該当なし」として通さない', async () => {
    await expect(
      reviewGenreForUser(
        {
          userId,
          blogId,
          genreId: await createGenre('LOW'),
          serpTop10: [],
          userHasExperience: true,
        },
        { skipAi: true },
      ),
    ).rejects.toMatchObject({ code: PLANNING_ERROR_CODES.invalidStep1Input });

    expect(await prisma.planningRun.count()).toBe(0);
  });
});

describe('差し戻し2回で選択肢が出る（完了条件）', () => {
  async function reject(): Promise<boolean> {
    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('HIGH', `NG-${Math.random()}`),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { skipAi: true },
    );

    return result.canOverride;
  }

  it('1回目・2回目は出ない。2回差し戻すと出る', async () => {
    expect(await reject()).toBe(false);
    expect(await reject()).toBe(true);
  });

  /** **通ったときは出さない。** 承知で進める必要が無い */
  it('通ったジャンルでは出ない', async () => {
    await reject();
    await reject();

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { skipAi: true },
    );

    expect(result.judgement.decision).toBe('PASSED');
    expect(result.canOverride).toBe(false);
  });
});

describe('承知で進める', () => {
  async function rejectTwice(): Promise<void> {
    for (let index = 0; index < 2; index += 1) {
      await reviewGenreForUser(
        {
          userId,
          blogId,
          genreId: await createGenre('HIGH', `NG-${index}`),
          serpTop10: HEALTHY_SERP,
          userHasExperience: true,
        },
        { skipAi: true },
      );
    }
  }

  /** **早く通すと停止条件が実質的に無くなる** */
  it('差し戻し2回より前は通さない', async () => {
    await expect(
      overrideGenreBlockForUser({
        userId,
        blogId,
        genreId: await createGenre('HIGH'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      }),
    ).rejects.toMatchObject({
      code: PLANNING_ERROR_CODES.overrideNotAllowed,
      status: 409,
    });
  });

  it('2回差し戻したあとは選べる', async () => {
    await rejectTwice();

    const result = await overrideGenreBlockForUser({
      userId,
      blogId,
      genreId: await createGenre('HIGH', '最後'),
      serpTop10: HEALTHY_SERP,
      userHasExperience: true,
    });

    expect(result.run.step1Status).toBe('OVERRIDDEN');
    expect(result.run.overriddenAt).toBeInstanceOf(Date);
  });

  /**
   * **「承知で進める」を横断で辿れるようにする**（SPEC 9.2.2、H-11）。
   * 選択そのものは `planning_runs.overridden_at` にも残るが、
   * そちらはブログ単位でしか引けない
   */
  it('監査ログに残る', async () => {
    await rejectTwice();

    const result = await overrideGenreBlockForUser({
      userId,
      blogId,
      genreId: await createGenre('HIGH', '最後'),
      serpTop10: HEALTHY_SERP,
      userHasExperience: true,
    });

    const logs = await listAuditLogsForAdmin({ entityType: 'planning_run' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'GENRE_BLOCK_OVERRIDDEN',
      actorUserId: userId,
      entityId: result.run.id,
    });
    expect(logs[0]?.metadata).toMatchObject({ rejectionCount: 2 });
  });

  /** **判定は書き換えない。** 停止した事実と理由は残す */
  it('停止の理由は残る', async () => {
    await rejectTwice();

    const result = await overrideGenreBlockForUser({
      userId,
      blogId,
      genreId: await createGenre('HIGH', '最後'),
      serpTop10: HEALTHY_SERP,
      userHasExperience: true,
    });

    expect(result.judgement.decision).toBe('BLOCKED');
    expect(result.run.reasons).toContain('ymyl_high');
  });

  /** 続行を選んだ回は差し戻しではない */
  it('OVERRIDDEN は差し戻しに数えない', async () => {
    await rejectTwice();
    await overrideGenreBlockForUser({
      userId,
      blogId,
      genreId: await createGenre('HIGH', '最後'),
      serpTop10: HEALTHY_SERP,
      userHasExperience: true,
    });

    const runs = await listPlanningRunsForUser({ userId, blogId });

    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.step1Status === 'BLOCKED')).toHaveLength(2);
  });
});

describe('AIの扱い', () => {
  it('説明文を受け取る', async () => {
    respond = () => ({
      status: 200,
      body: aiText({ summary: '個人ブログが少なめです', cautions: ['注意'] }),
    });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(result.text?.summary).toBe('個人ブログが少なめです');
    expect(result.text?.cautions).toEqual(['注意']);
  });

  /** JSONにならなければ**1回だけ**やり直す（CONTENT_PLANNING 1.2） */
  it('壊れた応答は1回だけやり直す', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'これはJSONではありません' }],
        usage: {},
      }),
    });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(result.text).toBeNull();
    expect(calls).toBe(2);
  });

  /** 禁じてあるが、来たものは読む（1回の再試行を無駄にしない） */
  it('コードフェンス付きでも読む', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        content: [
          {
            type: 'text',
            text: '```json\n{"summary":"読めました","cautions":[]}\n```',
          },
        ],
        usage: {},
      }),
    });

    const result = await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(result.text?.summary).toBe('読めました');
    expect(calls).toBe(1);
  });

  /** 通ったジャンルで候補を出しに行かない（無駄な費用） */
  it('通ったときは候補を呼ばない', async () => {
    await reviewGenreForUser(
      {
        userId,
        blogId,
        genreId: await createGenre('LOW'),
        serpTop10: HEALTHY_SERP,
        userHasExperience: true,
      },
      { provider: provider() },
    );

    expect(calls).toBe(1);
  });
});

describe('他人のブログは審査できない', () => {
  it('他人のブログIDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      reviewGenreForUser(
        {
          userId,
          blogId: otherBlog.id,
          genreId: await createGenre('LOW'),
          serpTop10: HEALTHY_SERP,
          userHasExperience: true,
        },
        { skipAi: true },
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(await prisma.planningRun.count()).toBe(0);
  });
});
