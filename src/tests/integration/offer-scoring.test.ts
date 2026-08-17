import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import { listOffersForUser } from '@/modules/affiliate';
import {
  ADOPTION_MIN_SCORE,
  EXCLUSION_REASONS,
  scoreOffersForUser,
} from '@/modules/content-planning';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * STEP 2 案件スコアリングを**実PostgreSQL・実HTTPサーバーで**確かめる
 * （TASKS E-5、SPEC 9.2.3）。
 *
 * 確かめるのは3つ。
 *
 * 1. **採点結果が `selection_score` と `score_breakdown` に残る**
 * 2. **足切りされた案件も内訳が残る**（落ちた理由を後から辿れる）
 * 3. **AIが点数を返しても使わない**（写像はコード側の定数）
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
  return createAiProvider({ env: { ANTHROPIC_API_KEY: 'sk-test' }, baseUrl });
}

interface OfferOverrides {
  name?: string;
  conversionType?: 'FREE_SIGNUP' | 'REQUEST' | 'TRIAL' | 'PURCHASE';
  rewardYen?: number | null;
  denyConditions?: string[];
  userExperience?: 'USED' | 'NOT_USED' | 'UNKNOWN';
  lpFormFields?: number | null;
  lpMobileReady?: boolean | null;
  evaluated?: boolean;
  blogPostingProhibited?: boolean;
  status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'NEEDS_REVIEW';
}

let offerSequence = 0;

/** LP評価済み・満点近い案件を作る */
async function createOffer(overrides: OfferOverrides = {}): Promise<string> {
  offerSequence += 1;
  const evaluated = overrides.evaluated ?? true;

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: overrides.name ?? `案件${offerSequence}`,
      aspName: 'テストASP',
      landingPageUrl: `https://example.com/lp/${offerSequence}`,
      affiliateUrl: `https://example.com/go/${offerSequence}`,
      // **リンクがある＝提携は承認済み**（Q-060）
      partnershipStatus: 'APPROVED',
      conversionType: overrides.conversionType ?? 'FREE_SIGNUP',
      rewardYen:
        overrides.rewardYen === undefined ? 10_000 : overrides.rewardYen,
      facts: {},
      denyConditions: overrides.denyConditions ?? [],
      userExperience: overrides.userExperience ?? 'USED',
      lpFormFields: evaluated ? (overrides.lpFormFields ?? 4) : null,
      lpMobileReady: evaluated ? (overrides.lpMobileReady ?? true) : null,
      lpEvaluatedAt: evaluated ? new Date('2026-08-01T00:00:00Z') : null,
      blogPostingProhibited: overrides.blogPostingProhibited ?? false,
      status: overrides.status ?? 'ACTIVE',
    },
    select: { id: true },
  });

  return offer.id;
}

async function storedScore(offerId: string) {
  return prisma.affiliateOffer.findUnique({
    where: { id: offerId },
    select: { selectionScore: true, scoreBreakdown: true },
  });
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
    body: aiText({ demand: 'HIGH', note: '検索されています' }),
  });
});

describe('採点結果の保存', () => {
  it('得点と内訳が案件に残る', async () => {
    const offerId = await createOffer();

    await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { provider: provider() },
    );

    const stored = await storedScore(offerId);

    expect(stored?.selectionScore).toBe(100);
    expect(stored?.scoreBreakdown).toMatchObject({
      conversionPoint: 30,
      reward: 20,
      lpQuality: 20,
      searchDemand: 15,
      experience: 10,
      denyConditions: 5,
      total: 100,
      excludedBy: null,
    });
  });

  /** **落ちた理由を後から確かめられないと「なぜ採用されなかったのか」に答えられない** */
  it('足切りされた案件も内訳が残る', async () => {
    const offerId = await createOffer({ status: 'ENDED' });

    await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      {
        skipAi: true,
      },
    );

    const stored = await storedScore(offerId);

    expect(stored?.scoreBreakdown).toMatchObject({
      excludedBy: EXCLUSION_REASONS.ended,
    });
  });
});

describe('採用', () => {
  it('60点以上の上位3件を採用する', async () => {
    for (let index = 0; index < 5; index += 1) {
      await createOffer();
    }
    // 60点に届かない案件
    await createOffer({
      conversionType: 'PURCHASE',
      rewardYen: 3_000,
      lpFormFields: 11,
      userExperience: 'NOT_USED',
    });

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { skipAi: true },
    );

    expect(result.scored).toHaveLength(6);
    expect(result.adopted).toHaveLength(3);
    for (const entry of result.adopted) {
      expect(entry.breakdown.total).toBeGreaterThanOrEqual(ADOPTION_MIN_SCORE);
    }
  });

  /** SPEC 9.2.3「60点以上が0件の場合はSTEP 1へ差し戻す」 */
  it('採用0件なら差し戻しを求める', async () => {
    await createOffer({
      conversionType: 'PURCHASE',
      rewardYen: 3_000,
      lpFormFields: 11,
      userExperience: 'NOT_USED',
    });

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { skipAi: true },
    );

    expect(result.adopted).toEqual([]);
    expect(result.needsGenreReview).toBe(true);
  });

  it('案件が1件も無ければ差し戻しを求める', async () => {
    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { skipAi: true },
    );

    expect(result.scored).toEqual([]);
    expect(result.needsGenreReview).toBe(true);
  });
});

describe('未評価の案件', () => {
  /**
   * **0点として採点しない。** LPが良い案件が「LPの質0点」で沈み、
   * 落選の理由が「測っていない」から「質が低い」に化ける。
   */
  it('採点対象外にして別に数える', async () => {
    await createOffer({ evaluated: false });
    await createOffer();

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { skipAi: true },
    );

    expect(result.unevaluated).toHaveLength(1);
    expect(result.adopted).toHaveLength(1);
  });
});

describe('AIの扱い', () => {
  /** **AIが点数を返しても使わない**（写像はコード側の定数） */
  it('AIが返した点数を使わない', async () => {
    respond = () => ({
      status: 200,
      body: aiText({ demand: 'NONE', note: '需要なし', score: 100 }),
    });

    const offerId = await createOffer();

    await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { provider: provider() },
    );

    const stored = await storedScore(offerId);

    // demand: NONE → 検索需要は0点。AIの score: 100 は無視される
    expect(stored?.scoreBreakdown).toMatchObject({ searchDemand: 0 });
    expect(stored?.selectionScore).toBe(85);
  });

  /**
   * **落ちても採点は止まらない。** 検索需要が0点になるだけ
   * （通るべき案件が落ちるほうが、通すべきでない案件を通すより安全）
   */
  it('AIが失敗しても採点する', async () => {
    respond = () => ({ status: 500, body: '{}' });

    const offerId = await createOffer();

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { provider: provider() },
    );

    expect(result.adopted).toHaveLength(1);
    expect((await storedScore(offerId))?.scoreBreakdown).toMatchObject({
      searchDemand: 0,
    });
  });

  /** **足切りされる案件にAIを聞かない。** 採用しないので費用が無駄になる */
  it('足切りされる案件では呼ばない', async () => {
    await createOffer({ status: 'ENDED' });
    await createOffer({ blogPostingProhibited: true });

    await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { provider: provider() },
    );

    expect(calls).toBe(0);
  });
});

describe('他人の案件は採点できない', () => {
  it('他人のブログIDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      scoreOffersForUser(
        { userId, blogId: otherBlog.id, genreName: '節約' },
        { skipAi: true },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * **他人の案件の点数を書き換えられない。** 保存は `blog_id` を
   * 条件に含める（C-6 と同じ形の穴を作らない）。
   */
  it('他人の案件は採点対象に入らない', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);
    const otherOffer = await prisma.affiliateOffer.create({
      data: {
        blogId: otherBlog.id,
        name: '他人の案件',
        aspName: 'ASP',
        landingPageUrl: 'https://example.com/lp',
        affiliateUrl: 'https://example.com/go',
        // **リンクがある＝提携は承認済み**（Q-060）
        partnershipStatus: 'APPROVED',
        conversionType: 'FREE_SIGNUP',
        facts: {},
        denyConditions: [],
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    await createOffer();
    await scoreOffersForUser(
      { userId, blogId, genreName: '節約' },
      { skipAi: true },
    );

    expect((await storedScore(otherOffer.id))?.selectionScore).toBeNull();

    // 自分の案件だけが採点されている
    const mine = await listOffersForUser({ userId, blogId });
    expect(mine.every((offer) => offer.selectionScore !== null)).toBe(true);
  });
});
