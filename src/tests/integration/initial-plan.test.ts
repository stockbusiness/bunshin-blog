import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { enqueueInitialPlansForUser } from '@/app/api/onboarding/initial-plan';
import { createOfferForUser } from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 初期構成表の積み込みを**実PostgreSQLで**確かめる
 * （TASKS I-10、OPEN_QUESTIONS Q-039 の (a)）。
 *
 * **`PLAN_GENERATION` を積む経路がどこにも無かった**（棚卸し・2026-08-12）。
 * ハンドラは E-9 で登録済みだが、**構成表が無いので I-4 が積む記事生成も
 * 対象を1件も見つけられない**状態だった。
 *
 * ここで確かめるのは、**整っていないブログを飛ばすこと**と、
 * **何度通っても増えないこと。**
 */

let prisma: PrismaClient;
let userId: string;

async function blogWithGenre(
  name: string,
  slotNumber: number,
): Promise<string> {
  const blog = await createBlog(prisma, userId, { name, slotNumber });

  const genre = await prisma.genre.create({
    data: {
      name: `ジャンル${slotNumber}`,
      category: 'その他',
      ymylRisk: 'LOW',
      status: 'APPROVED',
    },
    select: { id: true },
  });

  await prisma.blog.update({
    where: { id: blog.id },
    data: { genreId: genre.id },
  });

  return blog.id;
}

async function addOffer(
  blogId: string,
  status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'NEEDS_REVIEW',
): Promise<string> {
  const offer = await createOfferForUser(
    { userId, blogId },
    {
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://lp.example.com/a',
      affiliateUrl: 'https://asp.example/click?a=1',
      conversionType: 'FREE_SIGNUP',
    },
  );

  if (status !== undefined && status !== 'DRAFT') {
    await prisma.affiliateOffer.update({
      where: { id: offer.id },
      data: { status },
    });
  }

  return offer.id;
}

function planJobs() {
  return prisma.job.findMany({
    where: { jobType: 'PLAN_GENERATION' },
    select: { blogId: true, idempotencyKey: true, inputJson: true },
  });
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

describe('整っているブログを積む', () => {
  it('ジャンルと案件があれば積む', async () => {
    const blogId = await blogWithGenre('ブログ', 1);
    const offerId = await addOffer(blogId);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result).toMatchObject({ queued: 1, skipped: 0, failed: 0 });

    const [job] = await planJobs();

    expect(job?.blogId).toBe(blogId);
    expect(job?.idempotencyKey).toBe(`PLAN_GENERATION:${blogId}:INITIAL`);
    // **入力が要る。** `genreName` と `adoptedOfferIds` が無いと
    // ハンドラが 400 で落ちる（E-9）
    expect(job?.inputJson).toMatchObject({
      genreName: 'ジャンル1',
      adoptedOfferIds: [offerId],
    });
  });

  /** **登録した直後の状態**（`DRAFT`）でも採用として扱う */
  it.each([
    { name: '登録した直後', status: 'DRAFT' as const },
    { name: '使用中', status: 'ACTIVE' as const },
  ])('$name の案件は構成表に渡す', async ({ status }) => {
    const blogId = await blogWithGenre('ブログ', 1);
    await addOffer(blogId, status);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result.queued).toBe(1);
  });

  /** **どれも「いまは使わない」という明示の意思表示である** */
  it.each([
    { name: '止めた', status: 'PAUSED' as const },
    { name: '終わった', status: 'ENDED' as const },
    { name: '要確認', status: 'NEEDS_REVIEW' as const },
  ])('$name 案件しか無ければ積まない', async ({ status }) => {
    const blogId = await blogWithGenre('ブログ', 1);
    await addOffer(blogId, status);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result).toMatchObject({ queued: 0, skipped: 1 });
  });
});

/**
 * **オンボーディングの完了は1ブログでも条件を満たせば済み**（H-2a）。
 * 完了した時点で、まだ整っていないブログがありうる
 */
describe('整っていないブログを飛ばす', () => {
  it('ジャンルが無ければ積まない', async () => {
    const blogId = (await createBlog(prisma, userId, { name: 'ブログ' })).id;
    await addOffer(blogId);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result).toMatchObject({ queued: 0, skipped: 1 });
    expect(await planJobs()).toHaveLength(0);
  });

  /** **収益記事が作れず、集客記事の誘導先も無い構成表になる**（SPEC 9.2） */
  it('案件が無ければ積まない', async () => {
    await blogWithGenre('ブログ', 1);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result).toMatchObject({ queued: 0, skipped: 1 });
  });

  it('整っているブログだけを積む', async () => {
    const ready = await blogWithGenre('整っている', 1);
    await addOffer(ready);
    await blogWithGenre('ジャンルだけ', 2);

    const result = await enqueueInitialPlansForUser(userId);

    expect(result).toMatchObject({ queued: 1, skipped: 1 });
    expect((await planJobs())[0]?.blogId).toBe(ready);
  });
});

/**
 * **この画面はオンボーディング中ずっと開かれる。** 積む条件が揃った後は
 * 毎回この関数を通る
 */
describe('何度通っても増えない', () => {
  it('二度目は積まない', async () => {
    const blogId = await blogWithGenre('ブログ', 1);
    await addOffer(blogId);

    await enqueueInitialPlansForUser(userId);
    const second = await enqueueInitialPlansForUser(userId);

    expect(second.queued).toBe(0);
    expect(await planJobs()).toHaveLength(1);
  });

  /** **案件を足しても作り直さない**（作り直しは別の経路。未実装） */
  it('案件が増えても積み直さない', async () => {
    const blogId = await blogWithGenre('ブログ', 1);
    await addOffer(blogId);

    await enqueueInitialPlansForUser(userId);
    await addOffer(blogId);
    const second = await enqueueInitialPlansForUser(userId);

    expect(second.queued).toBe(0);
    expect(await planJobs()).toHaveLength(1);
  });
});

/** ブログが無い利用者でも落ちない（登録直後） */
it('ブログが無くても落ちない', async () => {
  const result = await enqueueInitialPlansForUser(userId);

  expect(result).toMatchObject({ queued: 0, skipped: 0, failed: 0 });
});
