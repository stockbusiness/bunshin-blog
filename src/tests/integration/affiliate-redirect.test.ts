import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { GET } from '@/app/go/[code]/route';
import {
  createOfferForUser,
  ensureRedirectLinkForUser,
  findRedirectTargetByCode,
} from '@/modules/affiliate';
import { createBlogForUser } from '@/modules/blogs';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * リダイレクタとクリック計測を**実PostgreSQLで**確かめる（TASKS D-8）。
 *
 * 完了条件は「リンク方式に従って組み立てられ、**`REDIRECT` の案件で
 * クリックが記録される**。`DIRECT` の案件は直リンクのまま」（Q-001）。
 *
 * ルートハンドラを直接呼ぶ。**認証が無い入口**なので、セッションの
 * 組み立てが要らない。
 */

let contentItemId: string;

/** 投稿先として使う `content_items` を1件作る（Phase E の代役） */
async function createContentItem(blogId_: string): Promise<string> {
  const plan =
    (await prisma.contentPlan.findFirst({
      where: { blogId: blogId_ },
      select: { id: true },
    })) ??
    (await prisma.contentPlan.create({
      data: {
        blogId: blogId_,
        planType: 'INITIAL',
        status: 'DRAFT',
        strategySnapshot: {},
      },
      select: { id: true },
    }));

  const sequenceNo =
    (await prisma.contentItem.count({ where: { contentPlanId: plan.id } })) + 1;

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId: blogId_,
      sequenceNo,
      contentType: 'AFFILIATE',
      title: '記事',
      searchIntent: '購入検討',
      objective: 'REVENUE',
      publishPriority: 1,
    },
    select: { id: true },
  });

  return item.id;
}

let prisma: PrismaClient;
let owner: { id: string };
let blogId: string;

async function createOffer(
  linkMode: 'REDIRECT' | 'DIRECT',
  subIdParam: string | null = 'sub',
): Promise<string> {
  const offer = await createOfferForUser(
    { userId: owner.id, blogId },
    {
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://lp.example.com/offer',
      affiliateUrl: 'https://asp.example/click?a=xxxx',
      conversionType: 'FREE_SIGNUP',
    },
  );

  // link_mode と sub_id_param は ADMIN が SQL で設定する（Q-001・Q-014）
  await prisma.affiliateOffer.update({
    where: { id: offer.id },
    data: { linkMode, subIdParam },
  });

  return offer.id;
}

/** `/go/<code>` を叩く */
async function callGo(
  code: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return GET(new Request(`https://app.example.com/go/${code}`, { headers }), {
    params: Promise.resolve({ code }),
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

  owner = await createUser(prisma, { displayName: '所有者' });
  blogId = (
    await createBlogForUser(owner.id, {
      name: 'ブログ',
      slug: 'mine',
      targetReader: '読者',
      slotNumber: 1,
    })
  ).id;
  contentItemId = await createContentItem(blogId);
});

describe('リンクの発行', () => {
  it('REDIRECT の案件でコードと飛び先を作る', async () => {
    const offerId = await createOffer('REDIRECT');

    const link = await ensureRedirectLinkForUser({
      userId: owner.id,
      blogId,
      offerId,
      contentItemId,
      slotNumber: 1,
    });

    expect(link.code).toHaveLength(22);
    // **リダイレクタを経由してもサブIDは落とさない**（Q-001）
    expect(link.destinationUrl).toBe(
      `https://asp.example/click?a=xxxx&sub=1-${contentItemId}`,
    );
  });

  /**
   * **記事を再生成するたびに新しいコードを発行しない。**
   * 公開済み記事に埋まった古いコードが宙に浮く（消せば404、残せば
   * クリック数が分散する）。
   */
  it('同じ案件×記事では作り直さない', async () => {
    const offerId = await createOffer('REDIRECT');
    const params = {
      userId: owner.id,
      blogId,
      offerId,
      contentItemId,
      slotNumber: 1,
    };

    const first = await ensureRedirectLinkForUser(params);
    const second = await ensureRedirectLinkForUser(params);

    expect(second.code).toBe(first.code);
    expect(await prisma.affiliateLink.count()).toBe(1);
  });

  /** `DIRECT` は直リンクのまま出す（Q-001）ので、行を作る意味が無い */
  it('DIRECT の案件では発行しない', async () => {
    const offerId = await createOffer('DIRECT');

    await expect(
      ensureRedirectLinkForUser({
        userId: owner.id,
        blogId,
        offerId,
        contentItemId,
        slotNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(await prisma.affiliateLink.count()).toBe(0);
  });

  it('他人の案件では発行できない', async () => {
    const other = await createUser(prisma, { displayName: '別ユーザー' });
    const otherBlog = (
      await createBlogForUser(other.id, {
        name: '他人のブログ',
        slug: 'theirs',
        targetReader: '読者',
        slotNumber: 1,
      })
    ).id;
    const offerId = await createOffer('REDIRECT');

    await expect(
      ensureRedirectLinkForUser({
        userId: other.id,
        blogId: otherBlog,
        offerId,
        contentItemId,
        slotNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('リダイレクトとクリック記録（完了条件）', () => {
  let code: string;
  let linkId: string;

  beforeEach(async () => {
    const offerId = await createOffer('REDIRECT');
    const link = await ensureRedirectLinkForUser({
      userId: owner.id,
      blogId,
      offerId,
      contentItemId,
      slotNumber: 1,
    });
    code = link.code;
    linkId = link.id;
  });

  it('飛び先へ302で送る', async () => {
    const response = await callGo(code);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `https://asp.example/click?a=xxxx&sub=1-${contentItemId}`,
    );
  });

  // 301 だとブラウザが覚えてしまい、以後クリックを数えられない
  it('301 で送らない', async () => {
    expect((await callGo(code)).status).not.toBe(301);
  });

  it('キャッシュさせない', async () => {
    expect((await callGo(code)).headers.get('cache-control')).toContain(
      'no-store',
    );
  });

  it('クリックが記録される', async () => {
    await callGo(code);

    const clicks = await prisma.linkClick.findMany({
      where: { affiliateLinkId: linkId },
    });

    expect(clicks).toHaveLength(1);
  });

  it('参照元のホストだけを残す', async () => {
    await callGo(code, {
      referer: 'https://monitor-blog.example.com/article?token=secret',
      'user-agent': 'Mozilla/5.0 (iPhone)',
    });

    const click = await prisma.linkClick.findFirstOrThrow({
      where: { affiliateLinkId: linkId },
    });

    expect(click.referrerHost).toBe('monitor-blog.example.com');
    // 生のURLとUAは残さない
    expect(click.referrerHost).not.toContain('secret');
    expect(click.userAgentHash).not.toContain('iPhone');
    expect(click.userAgentHash).toHaveLength(64);
  });

  /** SPEC 11.4「referrerが欠落する場合があるため、完全値として扱わない」 */
  it('Referer が無くても記録する', async () => {
    await callGo(code);

    const click = await prisma.linkClick.findFirstOrThrow({
      where: { affiliateLinkId: linkId },
    });

    expect(click.referrerHost).toBeNull();
  });

  /**
   * **判別は G-4 の担当。** `referrer_host` を残してあるので後から
   * 数え直せる。
   */
  it('is_ai_referral は false で入る（判別は G-4）', async () => {
    await callGo(code, { referer: 'https://www.perplexity.ai/search' });

    const click = await prisma.linkClick.findFirstOrThrow({
      where: { affiliateLinkId: linkId },
    });

    expect(click.isAiReferral).toBe(false);
    // 後から数え直せるだけの情報は残っている
    expect(click.referrerHost).toBe('www.perplexity.ai');
  });

  it('複数回のクリックが積み上がる', async () => {
    await callGo(code);
    await callGo(code);
    await callGo(code);

    expect(
      await prisma.linkClick.count({ where: { affiliateLinkId: linkId } }),
    ).toBe(3);
  });
});

describe('見つからないコード', () => {
  it('404 を返す', async () => {
    const link = await ensureRedirectLinkForUser({
      userId: owner.id,
      blogId,
      offerId: await createOffer('REDIRECT'),
      contentItemId,
      slotNumber: 1,
    });

    const response = await callGo('a'.repeat(22));

    expect(response.status).toBe(404);
    // 存在するリンクのクリックは増えない
    expect(
      await prisma.linkClick.count({ where: { affiliateLinkId: link.id } }),
    ).toBe(0);
  });

  /** DBを引く前に形で弾く（総当たりの負荷を落とす） */
  it.each([['abc'], [''], ['../../etc/passwd'], ['a'.repeat(100)]])(
    '形が違うコード %o も404',
    async (code) => {
      expect((await callGo(code)).status).toBe(404);
      expect(await findRedirectTargetByCode(code)).toBeNull();
    },
  );

  /**
   * **理由を分けない。** 「コードが無い」と「案件が終了した」を区別すると、
   * 総当たりで有効なリンクの有無を調べられる。
   */
  it('本文に内部の事情を出さない', async () => {
    const body = await (await callGo('a'.repeat(22))).text();

    expect(body).not.toContain('affiliate');
    expect(body).not.toContain('code');
  });
});
