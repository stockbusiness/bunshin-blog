import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  createOfferForUser,
  readLinkableOfferForUser,
  updateOfferForUser,
} from '@/modules/affiliate';
import {
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
 * 提携状態（Q-060、構想書13章）を**実PostgreSQLで**確かめる。
 *
 * 受け入れ条件は「**未提携・否認の案件は記事候補から除外される**」。
 *
 * 守りたいのは4つ。
 *
 * 1. **提携が承認されるまでリンクは発行できない。** 待つ間も登録できる
 * 2. **リンクを入れたら承認済み。** 状態を別に打たせない
 * 3. **承認されていない案件は記事候補に入らない**（受け入れ条件）
 * 4. **「承認済みでリンクが無い」行を作れない**（DBが止める）
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

function offerInput(overrides: Record<string, unknown> = {}) {
  return {
    name: '格安SIM A',
    aspName: 'テストASP',
    landingPageUrl: 'https://lp.example.com/a',
    conversionType: 'FREE_SIGNUP' as const,
    rewardYen: 1_480,
    userExperience: 'USED' as const,
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
  blogId = (await createBlog(prisma, userId)).id;
});

describe('登録するとき', () => {
  /** **リンクは提携が承認されないと発行できない**ので、状態を別に聞かない */
  it('リンクを入れれば提携済みになる', async () => {
    const offer = await createOfferForUser(
      { userId, blogId },
      offerInput({ affiliateUrl: 'https://asp.example.com/click?a=1' }),
    );

    expect(offer.partnershipStatus).toBe('APPROVED');
  });

  /**
   * **承認を待つ間も登録できる。** できないと、モニターは
   * 「あの案件を申請した」ことを覚えておくしかない（Q-058）。
   */
  it('リンクが無くても登録できる', async () => {
    const offer = await createOfferForUser({ userId, blogId }, offerInput());

    expect(offer.affiliateUrl).toBeNull();
    expect(offer.partnershipStatus).toBe('NOT_APPLIED');
  });

  it('申請済みなら審査中になる', async () => {
    const offer = await createOfferForUser(
      { userId, blogId },
      offerInput({ applied: true }),
    );

    expect(offer.partnershipStatus).toBe('APPLIED');
  });

  /** **フォームの未入力は空文字で届く。** URLとして検証すると必ず落ちる */
  it('空文字のリンクは「無い」として扱う', async () => {
    const offer = await createOfferForUser(
      { userId, blogId },
      offerInput({ affiliateUrl: '  ' }),
    );

    expect(offer.affiliateUrl).toBeNull();
  });
});

describe('あとから提携できたとき', () => {
  it('リンクを入れると承認済みになる', async () => {
    const created = await createOfferForUser(
      { userId, blogId },
      offerInput({ applied: true }),
    );

    const updated = await updateOfferForUser(
      { userId, blogId, offerId: created.id },
      { affiliateUrl: 'https://asp.example.com/click?a=1' },
    );

    expect(updated.partnershipStatus).toBe('APPROVED');
  });

  /** **断られたことは本人にしか分からない**（リンクが来ないだけでは同じ） */
  it('断られたと記録できる', async () => {
    const created = await createOfferForUser(
      { userId, blogId },
      offerInput({ applied: true }),
    );

    const updated = await updateOfferForUser(
      { userId, blogId, offerId: created.id },
      { partnershipStatus: 'REJECTED' },
    );

    expect(updated.partnershipStatus).toBe('REJECTED');
  });

  /**
   * **提携が切れてもリンクを消さない。** 一時的に切れただけで
   * 本人が発行したリンクを失うほうが困る。
   */
  it('断られてもリンクは残る', async () => {
    const created = await createOfferForUser(
      { userId, blogId },
      offerInput({ affiliateUrl: 'https://asp.example.com/click?a=1' }),
    );

    const updated = await updateOfferForUser(
      { userId, blogId, offerId: created.id },
      { partnershipStatus: 'REJECTED' },
    );

    expect(updated.affiliateUrl).toBe('https://asp.example.com/click?a=1');
  });

  /** **理由を伝える。** 制約違反にすると「保存できません」しか出ない */
  it('リンクが無いまま承認済みにはできない', async () => {
    const created = await createOfferForUser({ userId, blogId }, offerInput());

    await expect(
      updateOfferForUser(
        { userId, blogId, offerId: created.id },
        { partnershipStatus: 'APPROVED' },
      ),
    ).rejects.toThrow(/アフィリエイトリンク/);
  });
});

/**
 * **アプリを通らない経路でも作れない**（DBの CHECK）。
 * 承認済みでリンクの無い行があると、記事に空のリンクが出る。
 */
describe('DBが止めること', () => {
  it('承認済みでリンクが無い行は作れない', async () => {
    const created = await createOfferForUser({ userId, blogId }, offerInput());

    await expect(
      prisma.affiliateOffer.update({
        where: { id: created.id },
        data: { partnershipStatus: 'APPROVED' },
      }),
    ).rejects.toThrow();
  });
});

/**
 * **構想書13章の受け入れ条件。**
 * 「未提携・否認の案件は記事候補から除外される」
 */
describe('記事候補に入るか', () => {
  async function reasonFor(input: Record<string, unknown>) {
    await createOfferForUser({ userId, blogId }, offerInput(input));

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '通信' },
      { skipAi: true },
    );

    return result.scored[0]?.breakdown.excludedBy;
  }

  it('申請中は入らない', async () => {
    expect(await reasonFor({ applied: true })).toBe(
      EXCLUSION_REASONS.notPartnered,
    );
  });

  it('未申請は入らない', async () => {
    expect(await reasonFor({})).toBe(EXCLUSION_REASONS.notPartnered);
  });

  it('断られたものは別の理由で入らない', async () => {
    const created = await createOfferForUser(
      { userId, blogId },
      offerInput({ affiliateUrl: 'https://asp.example.com/click?a=1' }),
    );

    await updateOfferForUser(
      { userId, blogId, offerId: created.id },
      { partnershipStatus: 'REJECTED' },
    );

    const result = await scoreOffersForUser(
      { userId, blogId, genreName: '通信' },
      { skipAi: true },
    );

    expect(result.scored[0]?.breakdown.excludedBy).toBe(
      EXCLUSION_REASONS.partnershipRejected,
    );
  });

  /** **提携が理由で落ちていないこと**を確かめる（LPは未評価なので別の理由） */
  it('提携できていれば提携では落ちない', async () => {
    const reason = await reasonFor({
      affiliateUrl: 'https://asp.example.com/click?a=1',
    });

    expect(reason).toBe(EXCLUSION_REASONS.lpNotEvaluated);
  });
});

/**
 * **リンクの無い案件を記事に貼れない。** 足切りの抜けをここでも止める
 * （記事に空のリンクは出せない）。
 */
describe('記事へ貼るとき', () => {
  it('リンクの無い案件は断る', async () => {
    const created = await createOfferForUser({ userId, blogId }, offerInput());

    await expect(
      readLinkableOfferForUser({ userId, blogId, offerId: created.id }),
    ).rejects.toThrow(/提携/);
  });

  it('リンクがあれば返す', async () => {
    const created = await createOfferForUser(
      { userId, blogId },
      offerInput({ affiliateUrl: 'https://asp.example.com/click?a=1' }),
    );

    const linkable = await readLinkableOfferForUser({
      userId,
      blogId,
      offerId: created.id,
    });

    expect(linkable.affiliateUrl).toBe('https://asp.example.com/click?a=1');
  });
});
