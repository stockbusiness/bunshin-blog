import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createBlogForUser } from '@/modules/blogs';
import {
  checkOfferLinksForUser,
  createOfferForUser,
  listBrokenOfferLinksForUser,
} from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * リンク切れの状態を**実PostgreSQLで**確かめる（TASKS H-3b、Q-029）。
 *
 * 完了条件は「確認の結果を保存し、**いつから切れているか**が画面で分かる」。
 *
 * **`link_broken_at` が動かないこと**がこの試験の中心 — 動くと
 * 「いつからか」が毎回今日になり、モニターは直す優先度を決められない。
 */

let prisma: PrismaClient;
let userId: string;
let blogId: string;

const DAY = 24 * 60 * 60 * 1_000;
const FIRST = new Date('2026-08-01T00:00:00.000Z');
const LATER = new Date(FIRST.getTime() + 3 * DAY);

/** 応答を決め打ちする（実HTTPは C-7 の試験で見る） */
function respond(status: number) {
  return (async () =>
    new Response('', { status })) as unknown as typeof fetch as never;
}

async function offer(name: string, url = 'https://lp.example.com/a') {
  const created = await createOfferForUser(
    { userId, blogId },
    {
      name,
      aspName: 'ASP',
      landingPageUrl: url,
      affiliateUrl: 'https://asp.example/click?a=x',
      conversionType: 'FREE_SIGNUP',
      status: 'ACTIVE',
    },
  );

  return created.id;
}

function readState(offerId: string) {
  return prisma.affiliateOffer.findUniqueOrThrow({
    where: { id: offerId },
    select: { linkCheckedAt: true, linkBrokenAt: true },
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

  const persona = await createPersona(prisma, userId);
  const blog = await createBlogForUser(userId, {
    personaId: persona.id,
    name: 'ブログ',
    slug: 'blog',
    targetReader: '読者',
  });
  blogId = blog.id;
});

describe('確認の結果を残す', () => {
  it('通っていれば、確認時刻だけが入る', async () => {
    const offerId = await offer('生きている案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(200), now: FIRST },
    );

    expect(await readState(offerId)).toEqual({
      linkCheckedAt: FIRST,
      linkBrokenAt: null,
    });
  });

  it('消えていれば、切れ始めた時刻も入る', async () => {
    const offerId = await offer('終了した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );

    expect(await readState(offerId)).toEqual({
      linkCheckedAt: FIRST,
      linkBrokenAt: FIRST,
    });
  });

  /**
   * **これが中心。** 切れている間に時刻を動かすと、
   * 「いつからか」が毎回今日になる
   */
  it('切れ続けている間、切れ始めた時刻は動かない', async () => {
    const offerId = await offer('終了した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );
    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(410), now: LATER },
    );

    expect(await readState(offerId)).toEqual({
      // 確認時刻は進む
      linkCheckedAt: LATER,
      // **切れ始めた時刻は最初のまま**
      linkBrokenAt: FIRST,
    });
  });

  it('直れば、切れ始めた時刻は消える', async () => {
    const offerId = await offer('復活した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );
    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(200), now: LATER },
    );

    expect(await readState(offerId)).toEqual({
      linkCheckedAt: LATER,
      linkBrokenAt: null,
    });
  });
});

/**
 * **「分からなかった」を「確認した」にしない。** 時刻を入れると、
 * 画面には「今日確認済み」と出る
 */
describe('届かなかったとき', () => {
  it.each([
    { name: 'サーバーエラー', status: 500 },
    { name: '機械的なアクセスを弾かれた', status: 403 },
  ])('$name なら何も書かない', async ({ status }) => {
    const offerId = await offer('届かない案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(status), now: FIRST },
    );

    expect(await readState(offerId)).toEqual({
      linkCheckedAt: null,
      linkBrokenAt: null,
    });
  });

  /** 切れている案件が、届かなかっただけで「直った」ことにならない */
  it('切れている案件の状態を消さない', async () => {
    const offerId = await offer('終了した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );
    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(503), now: LATER },
    );

    expect(await readState(offerId)).toEqual({
      linkCheckedAt: FIRST,
      linkBrokenAt: FIRST,
    });
  });
});

describe('画面へ出す一覧', () => {
  it('切れているものだけを、古い順に返す', async () => {
    const first = await offer('先に切れた案件', 'https://lp.example.com/1');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );

    const second = await offer('後で切れた案件', 'https://lp.example.com/2');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: LATER },
    );

    const broken = await listBrokenOfferLinksForUser({ userId, blogId });

    expect(broken).toEqual([
      { offerId: first, offerName: '先に切れた案件', brokenAt: FIRST },
      { offerId: second, offerName: '後で切れた案件', brokenAt: LATER },
    ]);
  });

  it('直った案件は出ない', async () => {
    await offer('復活した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );
    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(200), now: LATER },
    );

    expect(await listBrokenOfferLinksForUser({ userId, blogId })).toEqual([]);
  });

  /** 終了した案件のリンクが切れていても、記事からは参照されない */
  it('ACTIVE でない案件は出ない', async () => {
    const offerId = await offer('終了した案件');

    await checkOfferLinksForUser(
      { userId, blogId },
      { fetchFn: respond(404), now: FIRST },
    );
    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: { status: 'ENDED' },
    });

    expect(await listBrokenOfferLinksForUser({ userId, blogId })).toEqual([]);
  });

  /** 他人のブログは 403 ではなく 404（IDの総当たりを防ぐ） */
  it('他人のブログは404', async () => {
    const other = await createUser(prisma);

    await expect(
      listBrokenOfferLinksForUser({ userId: other.id, blogId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
