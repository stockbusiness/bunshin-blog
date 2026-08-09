import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import * as aiCosts from '@/modules/ai-costs';
import * as affiliate from '@/modules/affiliate';
import * as banners from '@/modules/banners';
import * as contentPlanning from '@/modules/content-planning';
import * as blogs from '@/modules/blogs';
import * as personas from '@/modules/personas';
import * as settings from '@/modules/settings';
import * as wordpress from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * テナント越境の統合テスト（TASKS C-6、SPEC 14.1）。
 *
 * 完了条件は「**2ユーザー×2ブログで越境投稿が発生しない**」。
 *
 * ## なぜ単独のタスクなのか
 *
 * TASKS が「**C-6は必ず単独タスクにする。他タスクのついでに書かせると
 * 省略される**」と定めている。各タスクの統合テストは自分の機能を通すのが
 * 主目的で、越境は「ついでに1件」で済まされやすい。ここは逆で、
 * **越境させようとすることだけが目的**である。
 *
 * ## 攻め方
 *
 * 素直な「他人のブログIDを指定する」だけでは足りない。所有権の判定を
 * すり抜ける経路が2つある。
 *
 * - **自分のブログID + 他人の記事ID。** ブログの所有権は通る
 * - **他人のブログID + 自分の記事ID。** 記事の所有権は通る
 *
 * どちらも、片側だけを見ていると通ってしまう。
 *
 * ## 何を確かめるか
 *
 * 拒否されることだけでなく、**攻撃のあとに相手のデータが1バイトも
 * 変わっていないこと**まで見る。「エラーは返ったが書き込みは起きていた」
 * を見逃さないため。
 */

const SITE_A = 'https://blog-a.example.com';
const SITE_B = 'https://blog-b.example.com';
const INPUT = { title: '記事', content: '<p>本文</p>' };

let prisma: PrismaClient;

interface Tenant {
  userId: string;
  /** 1人につき2ブログ（完了条件の「2ユーザー×2ブログ」） */
  blogIds: [string, string];
  contentItemIds: [string, string];
  siteUrl: string;
}

let alice: Tenant;
let bob: Tenant;

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * 投稿先として使う `content_items` を1件作る（Phase E の代役）。
 *
 * `content_plans` は `(blog_id, plan_type, version)` で一意なため、
 * 同じブログでは既存の構成案を使い回す。
 */
async function createContentItem(blogId: string): Promise<string> {
  const plan =
    (await prisma.contentPlan.findFirst({
      where: { blogId },
      select: { id: true },
    })) ??
    (await prisma.contentPlan.create({
      data: {
        blogId,
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
      blogId,
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

/**
 * 偽WordPressが返す投稿ID。
 *
 * **1件ごとに変える。** 固定にすると `wordpress_posts` の
 * `(blog_id, wp_post_id)` 制約に当たり、越境とは無関係な理由で落ちる。
 */
let nextWpPostId = 1000;

/** すべて成功する WordPress を模す。**越境が通れば必ず投稿が起きる** */
function responder(
  input: wordpress.WordpressRequest,
): Partial<wordpress.WordpressApiResponse> {
  const method = (input.method ?? 'GET').toUpperCase();

  if (input.path === '/') {
    return { status: 200, json: { namespaces: ['wp/v2'] } };
  }
  if (input.path.startsWith('/wp/v2/users/me')) {
    return {
      status: 200,
      json: { id: 1, capabilities: { upload_files: true } },
    };
  }
  if (input.path === '/wp/v2/posts' && method === 'POST') {
    nextWpPostId += 1;

    return {
      status: 201,
      json: {
        id: nextWpPostId,
        status: 'draft',
        link: `https://example.com/?p=${nextWpPostId}`,
        content: { raw: (input.body as { content?: string })?.content ?? '' },
      },
    };
  }
  if (/^\/wp\/v2\/posts\/\d+\?context=edit$/.test(input.path)) {
    return {
      status: 200,
      json: {
        id: 4242,
        status: 'draft',
        date_gmt: '2026-08-08T01:00:00',
        content: { raw: (input.body as { content?: string })?.content ?? '' },
      },
    };
  }
  if (/^\/wp\/v2\/posts\/\d+$/.test(input.path) && method === 'POST') {
    return {
      status: 200,
      json: {
        id: 4242,
        status: 'draft',
        content: { raw: (input.body as { content?: string })?.content ?? '' },
      },
    };
  }
  if (method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

/** 呼ばれたリクエストを記録するクライアント */
function createFactory(calls: wordpress.WordpressRequest[]) {
  return (): wordpress.WordpressClient => ({
    async request(request) {
      calls.push(request);
      const result = responder(request);

      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        json: result.json ?? null,
        raw: JSON.stringify(result.json ?? null),
      };
    },
  });
}

async function createTenant(
  displayName: string,
  siteUrl: string,
  slugPrefix: string,
): Promise<Tenant> {
  const user = await createUser(prisma, { displayName });

  const created = [];
  for (const slotNumber of [1, 2] as const) {
    const blog = await blogs.createBlogForUser(user.id, {
      name: `${displayName}のブログ${slotNumber}`,
      slug: `${slugPrefix}-${slotNumber}`,
      targetReader: '読者',
      slotNumber,
    });

    await wordpress.connectWordpressForUser(
      { userId: user.id, blogId: blog.id },
      {
        siteUrl: `${siteUrl}/${slotNumber}`,
        wpUsername: `${slugPrefix}${slotNumber}`,
        appPassword: `pass ${slugPrefix} ${slotNumber} abcd efgh`,
      },
    );
    // C-2 を通さないと投稿できない
    await wordpress.testWordpressConnectionForUser(
      { userId: user.id, blogId: blog.id },
      createFactory([]),
    );

    created.push({
      blogId: blog.id,
      contentItemId: await createContentItem(blog.id),
    });
  }

  const [first, second] = created as [
    { blogId: string; contentItemId: string },
    { blogId: string; contentItemId: string },
  ];

  return {
    userId: user.id,
    blogIds: [first.blogId, second.blogId],
    contentItemIds: [first.contentItemId, second.contentItemId],
    siteUrl,
  };
}

/** 相手のデータをまるごと写し取る（攻撃の前後で比べる） */
async function snapshot(tenant: Tenant): Promise<string> {
  const rows = await prisma.blog.findMany({
    where: { userId: tenant.userId },
    orderBy: { slotNumber: 'asc' },
    include: { wordpress: true },
  });

  const posts = await prisma.wordpressPost.findMany({
    where: { blogId: { in: tenant.blogIds } },
    orderBy: { contentItemId: 'asc' },
  });

  return JSON.stringify({ rows, posts });
}

beforeEach(async () => {
  await resetDatabase(prisma);

  alice = await createTenant('アリス', SITE_A, 'alice');
  bob = await createTenant('ボブ', SITE_B, 'bob');

  // アリスは2ブログとも投稿済みにしておく（奪う対象を用意する）
  for (const index of [0, 1] as const) {
    await wordpress.publishDraftForUser(
      {
        userId: alice.userId,
        blogId: alice.blogIds[index],
        contentItemId: alice.contentItemIds[index],
      },
      INPUT,
      createFactory([]),
    );
  }
});

describe('前提', () => {
  it('2ユーザー×2ブログが揃っている', async () => {
    expect(await blogs.listBlogsForUser(alice.userId)).toHaveLength(2);
    expect(await blogs.listBlogsForUser(bob.userId)).toHaveLength(2);
    expect(await prisma.blog.count()).toBe(4);
    expect(await prisma.wordpressPost.count()).toBe(2);
  });

  // 攻撃が「たまたま失敗した」のではないことを示す対照
  it('自分のブログには投稿できる', async () => {
    const calls: wordpress.WordpressRequest[] = [];

    await wordpress.publishDraftForUser(
      {
        userId: bob.userId,
        blogId: bob.blogIds[0],
        contentItemId: bob.contentItemIds[0],
      },
      INPUT,
      createFactory(calls),
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(await prisma.wordpressPost.count()).toBe(3);
  });
});

describe('他人のブログIDを指定する', () => {
  it.each([
    [
      'ブログを引く',
      async (): Promise<unknown> =>
        blogs.findBlogForUser({ userId: bob.userId, blogId: alice.blogIds[0] }),
    ],
  ])('%s（null が返る）', async (_label, attempt) => {
    expect(await attempt()).toBeNull();
  });

  it.each([
    [
      'ブログを引く（必須）',
      (): Promise<unknown> =>
        blogs.requireBlogForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'ブログを更新する',
      (): Promise<unknown> =>
        blogs.updateBlogForUser(
          { userId: bob.userId, blogId: alice.blogIds[0] },
          { name: '乗っ取り' },
        ),
    ],
    [
      'ブログを閉じる',
      (): Promise<unknown> =>
        blogs.closeBlogForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      '接続情報を保存する',
      (): Promise<unknown> =>
        wordpress.connectWordpressForUser(
          { userId: bob.userId, blogId: alice.blogIds[0] },
          {
            siteUrl: 'https://attacker.example.com',
            wpUsername: 'attacker',
            appPassword: 'aaaa bbbb cccc dddd eeee ffff',
          },
        ),
    ],
    [
      '接続を切る',
      (): Promise<unknown> =>
        wordpress.disconnectWordpressForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      '接続を引く',
      (): Promise<unknown> =>
        wordpress.findWordpressConnectionForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      '認証情報を読む',
      (): Promise<unknown> =>
        wordpress.readWordpressCredentialsForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      '接続テストを走らせる',
      (): Promise<unknown> =>
        wordpress.testWordpressConnectionForUser(
          { userId: bob.userId, blogId: alice.blogIds[0] },
          createFactory([]),
        ),
    ],
    [
      '投稿する',
      (): Promise<unknown> =>
        wordpress.publishDraftForUser(
          {
            userId: bob.userId,
            blogId: alice.blogIds[0],
            contentItemId: alice.contentItemIds[0],
          },
          INPUT,
          createFactory([]),
        ),
    ],
    [
      '同期する',
      (): Promise<unknown> =>
        wordpress.syncWordpressPostForUser(
          {
            userId: bob.userId,
            blogId: alice.blogIds[0],
            contentItemId: alice.contentItemIds[0],
          },
          createFactory([]),
        ),
    ],
    [
      '投稿の記録を引く',
      (): Promise<unknown> =>
        wordpress.findWordpressPostForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          contentItemId: alice.contentItemIds[0],
        }),
    ],
    [
      'ブログのAI費用を見る',
      (): Promise<unknown> =>
        aiCosts.totalBlogCostForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'リダイレクタのリンクを発行する',
      (): Promise<unknown> =>
        affiliate.ensureRedirectLinkForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          offerId: '00000000-0000-4000-8000-000000000000',
          contentItemId: alice.contentItemIds[0],
          slotNumber: 1,
        }),
    ],
    [
      'ブログ別の人格設定を引く',
      (): Promise<unknown> =>
        personas.findBlogPersonaSettingForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'バナーを一覧する',
      (): Promise<unknown> =>
        banners.listBannersForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'バナーを登録する',
      (): Promise<unknown> =>
        banners.createBannerForUser(
          { userId: bob.userId, blogId: alice.blogIds[0] },
          {
            name: '割り込みバナー',
            imageUrl: 'https://cdn.example.com/a.png',
            destinationUrl: 'https://asp.example/click?a=x',
            slot: 'TOP',
          },
        ),
    ],
    [
      '案件を一覧する',
      (): Promise<unknown> =>
        affiliate.listOffersForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'ジャンルを審査する（E-4）',
      (): Promise<unknown> =>
        contentPlanning.reviewGenreForUser(
          {
            userId: bob.userId,
            blogId: alice.blogIds[0],
            genreId: '00000000-0000-4000-8000-000000000000',
            serpTop10: [{ domainType: 'personal' }],
            userHasExperience: true,
          },
          { skipAi: true },
        ),
    ],
    [
      '停止を承知で進める（E-4）',
      (): Promise<unknown> =>
        contentPlanning.overrideGenreBlockForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          genreId: '00000000-0000-4000-8000-000000000000',
          serpTop10: [{ domainType: 'personal' }],
          userHasExperience: true,
        }),
    ],
    [
      '審査の履歴を見る（E-4）',
      (): Promise<unknown> =>
        contentPlanning.listPlanningRunsForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      '構成表を組み立てる（E-8）',
      (): Promise<unknown> =>
        contentPlanning.buildPlanForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          genreName: '節約',
          adoptedOfferIds: [],
        }),
    ],
    [
      'リンク込みで記事を引く（E-8）',
      (): Promise<unknown> =>
        contentPlanning.listPlanItemsWithLinksForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          contentPlanId: '00000000-0000-4000-8000-000000000000',
        }),
    ],
    [
      '集客記事とリンクを設計する（E-7）',
      (): Promise<unknown> =>
        contentPlanning.designTrafficArticlesForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          contentPlanId: '00000000-0000-4000-8000-000000000000',
          genreName: '節約',
        }),
    ],
    [
      '構成表へ記事を足す（E-7）',
      (): Promise<unknown> =>
        contentPlanning.appendItemsToPlanForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          contentPlanId: '00000000-0000-4000-8000-000000000000',
          items: [],
        }),
    ],
    [
      'リンクを保存する（E-7）',
      (): Promise<unknown> =>
        contentPlanning.saveLinksForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          outbound: new Map(),
          inbound: new Map(),
        }),
    ],
    [
      '収益記事を設計する（E-6）',
      (): Promise<unknown> =>
        contentPlanning.designRevenueArticlesForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          adoptedOfferIds: [],
        }),
    ],
    [
      '構成表の記事を一覧する（E-6）',
      (): Promise<unknown> =>
        contentPlanning.listContentItemsForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
        }),
    ],
    [
      'いちばん新しい構成表を引く（E-6）',
      (): Promise<unknown> =>
        contentPlanning.findLatestPlanForUser({
          userId: bob.userId,
          blogId: alice.blogIds[0],
          planType: 'INITIAL',
        }),
    ],
    [
      '案件を採点する（E-5）',
      (): Promise<unknown> =>
        contentPlanning.scoreOffersForUser(
          {
            userId: bob.userId,
            blogId: alice.blogIds[0],
            genreName: '節約',
          },
          { skipAi: true },
        ),
    ],
    [
      '案件を登録する',
      (): Promise<unknown> =>
        affiliate.createOfferForUser(
          { userId: bob.userId, blogId: alice.blogIds[0] },
          {
            name: '割り込み案件',
            aspName: 'ASP',
            landingPageUrl: 'https://lp.example.com/a',
            affiliateUrl: 'https://asp.example/click?a=x',
            conversionType: 'FREE_SIGNUP',
          },
        ),
    ],
  ])('%s と 404 になる', async (_label, attempt) => {
    const before = await snapshot(alice);

    await expect(attempt()).rejects.toMatchObject({ status: 404 });

    // **エラーは返ったが書き込みは起きていた、を見逃さない**
    expect(await snapshot(alice)).toBe(before);
  });

  /**
   * **存在しないIDと他人のIDを区別しない。**
   * 区別すると、IDを総当たりして他人のブログの存在を調べられる。
   */
  it('存在しないブログIDと同じ扱いになる', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';

    const owned = await blogs
      .requireBlogForUser({ userId: bob.userId, blogId: alice.blogIds[0] })
      .catch((error: unknown) => error);
    const unknown = await blogs
      .requireBlogForUser({ userId: bob.userId, blogId: missing })
      .catch((error: unknown) => error);

    expect((owned as { code: string }).code).toBe(
      (unknown as { code: string }).code,
    );
    expect((owned as { message: string }).message).toBe(
      (unknown as { message: string }).message,
    );
  });
});

/**
 * **所有権の判定をすり抜ける経路。**
 *
 * ブログか記事の片側だけを見ていると通る。C-3 の「他ブログの
 * content_item に紐づく投稿を触らせない」がここを塞いでいる。
 */
describe('自分のブログID + 他人の記事ID', () => {
  it('投稿できない', async () => {
    const calls: wordpress.WordpressRequest[] = [];
    const before = await snapshot(alice);

    await expect(
      wordpress.publishDraftForUser(
        {
          userId: bob.userId,
          // ボブ自身のブログ。所有権の判定は通る
          blogId: bob.blogIds[0],
          // アリスの記事
          contentItemId: alice.contentItemIds[0],
        },
        INPUT,
        createFactory(calls),
      ),
    ).rejects.toMatchObject({ status: 404 });

    // **ボブのサイトへも投稿しない**（アリスの記事がボブのブログに出る）
    expect(calls).toHaveLength(0);
    expect(await snapshot(alice)).toBe(before);
    expect(await prisma.wordpressPost.count()).toBe(2);
  });

  it('同期できない', async () => {
    const calls: wordpress.WordpressRequest[] = [];
    const before = await snapshot(alice);

    await expect(
      wordpress.syncWordpressPostForUser(
        {
          userId: bob.userId,
          blogId: bob.blogIds[0],
          contentItemId: alice.contentItemIds[0],
        },
        createFactory(calls),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(calls).toHaveLength(0);
    expect(await snapshot(alice)).toBe(before);
  });

  it('投稿の記録を読めない', async () => {
    expect(
      await wordpress.findWordpressPostForUser({
        userId: bob.userId,
        blogId: bob.blogIds[0],
        contentItemId: alice.contentItemIds[0],
      }),
    ).toBeNull();
  });
});

/** 同じ利用者の中でも、ブログをまたいだ混線を許さない */
describe('自分の2つのブログの間', () => {
  it('別スロットの記事を、もう片方のブログから投稿できない', async () => {
    const calls: wordpress.WordpressRequest[] = [];

    await expect(
      wordpress.publishDraftForUser(
        {
          userId: alice.userId,
          blogId: alice.blogIds[1],
          // スロット1の記事
          contentItemId: alice.contentItemIds[0],
        },
        INPUT,
        createFactory(calls),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(calls).toHaveLength(0);
  });

  it('別スロットの記事の記録を、もう片方のブログから読めない', async () => {
    expect(
      await wordpress.findWordpressPostForUser({
        userId: alice.userId,
        blogId: alice.blogIds[1],
        contentItemId: alice.contentItemIds[0],
      }),
    ).toBeNull();
  });
});

describe('一覧と集計に他人が混ざらない', () => {
  it('ブログ一覧は自分のものだけ', async () => {
    const list = await blogs.listBlogsForUser(bob.userId);

    expect(list).toHaveLength(2);
    expect(list.map((blog) => blog.id).sort()).toEqual([...bob.blogIds].sort());
    for (const blog of list) {
      expect(alice.blogIds).not.toContain(blog.id);
    }
  });

  /** `CLOSED` を含めても増えない（他人の閉じたブログが漏れない） */
  it('CLOSED を含めても他人は出ない', async () => {
    await blogs.closeBlogForUser({
      userId: alice.userId,
      blogId: alice.blogIds[0],
    });

    const list = await blogs.listBlogsForUser(bob.userId, {
      includeClosed: true,
    });

    expect(list.map((blog) => blog.id).sort()).toEqual([...bob.blogIds].sort());
  });

  // アリスが2枠使っていても、ボブの空き枠の数え方に影響しない
  it('スロットの使用状況が他人と混ざらない', async () => {
    const usage = await blogs.getSlotUsageForUser(bob.userId);

    expect(usage.used).toHaveLength(2);
    for (const entry of usage.used) {
      expect(bob.blogIds).toContain(entry.blogId);
    }
  });
});

describe('認証情報が越境しない（SPEC 14.2）', () => {
  it('他人の認証情報を読み出せない', async () => {
    await expect(
      wordpress.readWordpressCredentialsForUser({
        userId: bob.userId,
        blogId: alice.blogIds[0],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * **暗号文を自分のブログへ写しても読めない。**
   * AAD が行と列に縛っている（C-1）。DBを直接書き換えられる立場でも、
   * 他人の認証情報は復号できない。
   */
  it('暗号文をコピーしても復号できない', async () => {
    const victim = await prisma.wordpressConnection.findUniqueOrThrow({
      where: { blogId: alice.blogIds[0] },
      select: { wpUsernameEncrypted: true, appPasswordEncrypted: true },
    });

    await prisma.wordpressConnection.update({
      where: { blogId: bob.blogIds[0] },
      data: {
        wpUsernameEncrypted: victim.wpUsernameEncrypted,
        appPasswordEncrypted: victim.appPasswordEncrypted,
      },
    });

    await expect(
      wordpress.readWordpressCredentialsForUser({
        userId: bob.userId,
        blogId: bob.blogIds[0],
      }),
    ).rejects.toMatchObject({
      code: wordpress.WORDPRESS_ERROR_CODES.credentialsUnreadable,
    });
  });
});

/**
 * **入口が増えたらこのテストも増やす。**
 *
 * C-6 は「他タスクのついでに書かせると省略される」ため単独タスクに
 * なっている。新しい `...ForUser` が生えたときに**ここが落ちる**ように
 * しておかないと、同じことが起きる。
 */
describe('入口の網羅', () => {
  const covered = {
    'ai-costs': [
      'summarizeCostForUser',
      'totalCostForUser',
      'totalBlogCostForUser',
      'totalContentItemCostForUser',
      'listAiUsageForUser',
    ],
    affiliate: [
      'listOffersForUser',
      'findOfferForUser',
      'requireOfferForUser',
      'createOfferForUser',
      'updateOfferForUser',
      'endOfferForUser',
      'readLinkableOfferForUser',
      'evaluateLandingPageForUser',
      'ensureRedirectLinkForUser',
      'saveOfferScoresForUser',
    ],
    banners: [
      'listBannersForUser',
      'findBannerForUser',
      'requireBannerForUser',
      'createBannerForUser',
      'updateBannerForUser',
      'endBannerForUser',
    ],
    personas: [
      'findUserPersonaForUser',
      'requireUserPersonaForUser',
      'saveUserPersonaForUser',
      'updateUserPersonaForUser',
      'findBlogPersonaSettingForUser',
      'saveBlogPersonaSettingForUser',
      'updateBlogPersonaSettingForUser',
      'resolveEffectivePersonaForUser',
      'listPersonaFactsForUser',
      'findPersonaFactForUser',
      'requirePersonaFactForUser',
      'createPersonaFactForUser',
      'updatePersonaFactForUser',
      'deletePersonaFactForUser',
      'setAllowedExperiencesForUser',
    ],
    blogs: [
      'listBlogsForUser',
      'findBlogForUser',
      'requireBlogForUser',
      'createBlogForUser',
      'updateBlogForUser',
      'closeBlogForUser',
      'getSlotUsageForUser',
    ],
    wordpress: [
      'connectWordpressForUser',
      'disconnectWordpressForUser',
      'findWordpressConnectionForUser',
      'readWordpressCredentialsForUser',
      'testWordpressConnectionForUser',
      'publishDraftForUser',
      'syncWordpressPostForUser',
      'findWordpressPostForUser',
    ],
    /**
     * **設定は利用者に紐づかない**（H-7、Q-017）。システム全体で1組で、
     * 触れるのは ADMIN だけ。所有権の判定に使える情報が無いため
     * `...ForUser` の入口は無い。
     *
     * ここを空で載せておくと、**うっかり利用者向けの入口を生やしたときに
     * 落ちる** — 設定は越境の対象になりようがない、という前提が崩れたことに
     * 気づける。
     */
    settings: [],
    'content-planning': [
      'reviewGenreForUser',
      'overrideGenreBlockForUser',
      'listPlanningRunsForUser',
      'scoreOffersForUser',
      'designRevenueArticlesForUser',
      'listContentItemsForUser',
      'findLatestPlanForUser',
      'designTrafficArticlesForUser',
      'appendItemsToPlanForUser',
      'saveLinksForUser',
      'buildPlanForUser',
      'listPlanItemsWithLinksForUser',
    ],
  } as const;

  it.each([
    ['ai-costs', aiCosts, covered['ai-costs']],
    ['affiliate', affiliate, covered.affiliate],
    ['banners', banners, covered.banners],
    ['blogs', blogs, covered.blogs],
    ['personas', personas, covered.personas],
    ['settings', settings, covered.settings],
    ['content-planning', contentPlanning, covered['content-planning']],
    ['wordpress', wordpress, covered.wordpress],
  ])(
    '%s の ...ForUser が全て把握されている',
    (_name, module_, expected: readonly string[]) => {
      const actual = Object.keys(module_)
        .filter((key) => key.endsWith('ForUser'))
        .sort();

      expect(actual).toEqual([...expected].sort());
    },
  );

  /**
   * `createBlogForUser` は他人のブログを指定しようがない（`userId` しか
   * 取らない）。**越境の攻撃面が無いことを明示しておく**
   */
  it('createBlogForUser は userId しか取らない', async () => {
    const blog = await blogs.createBlogForUser(bob.userId, {
      name: '3つめ',
      slug: 'bob-3',
      targetReader: '読者',
      slotNumber: 3,
    });

    expect(blog.userId).toBe(bob.userId);
  });
});

/**
 * **C-6 で実際に見つかった穴**（C-6-schema で塞いだ）。
 *
 * 相手が**まだ投稿していない**記事IDが対象。既に投稿済みなら
 * 「既存行の `blog_id` が違う」で弾かれるが、行が無いと誰も
 * 確かめていなかった。`content_item_id` は unique なので、一度
 * 登録されると**持ち主はその記事を二度と投稿できない**。
 */
/**
 * **リンクの案件と記事が同じブログに属することを、DBが強制する**（D-11・Q-020）。
 *
 * D-8 の時点では塞げていなかった。`affiliate` から記事の持ち主を確かめると
 * 依存が循環するため（`content-planning → affiliate` が正）、C-6 と同じく
 * **制約をDBへ置いた。**
 */
describe('自分の案件 + 他人の記事でリンクを作る', () => {
  it('他人の記事IDを紐づけたリンクを作れない', async () => {
    const alicesItem = await createContentItem(alice.blogIds[0]);

    const offer = await affiliate.createOfferForUser(
      { userId: bob.userId, blogId: bob.blogIds[0] },
      {
        name: '自分の案件',
        aspName: 'ASP',
        landingPageUrl: 'https://example.com/lp',
        affiliateUrl: 'https://asp.example/click?a=x',
        conversionType: 'FREE_SIGNUP',
        facts: {},
      },
    );

    await prisma.affiliateOffer.update({
      where: { id: offer.id },
      data: { linkMode: 'REDIRECT' },
    });

    await expect(
      affiliate.ensureRedirectLinkForUser({
        userId: bob.userId,
        blogId: bob.blogIds[0],
        offerId: offer.id,
        contentItemId: alicesItem,
        slotNumber: 1,
      }),
    ).rejects.toThrow();

    expect(
      await prisma.affiliateLink.count({
        where: { contentItemId: alicesItem },
      }),
    ).toBe(0);
  });

  it('自分の記事なら作れる', async () => {
    const offer = await affiliate.createOfferForUser(
      { userId: bob.userId, blogId: bob.blogIds[0] },
      {
        name: '自分の案件2',
        aspName: 'ASP',
        landingPageUrl: 'https://example.com/lp',
        affiliateUrl: 'https://asp.example/click?a=y',
        conversionType: 'FREE_SIGNUP',
        facts: {},
      },
    );

    await prisma.affiliateOffer.update({
      where: { id: offer.id },
      data: { linkMode: 'REDIRECT' },
    });

    const link = await affiliate.ensureRedirectLinkForUser({
      userId: bob.userId,
      blogId: bob.blogIds[0],
      offerId: offer.id,
      contentItemId: bob.contentItemIds[0],
      slotNumber: 1,
    });

    expect(link.contentItemId).toBe(bob.contentItemIds[0]);
  });
});

describe('自分のブログID + 他人の未投稿の記事ID', () => {
  let untouched: string;

  beforeEach(async () => {
    // アリスの3つめの記事。まだ投稿していない
    untouched = await createContentItem(alice.blogIds[0]);
  });

  it('自分のブログの投稿として登録できない', async () => {
    await expect(
      wordpress.publishDraftForUser(
        {
          userId: bob.userId,
          blogId: bob.blogIds[0],
          contentItemId: untouched,
        },
        INPUT,
        createFactory([]),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(
      await prisma.wordpressPost.count({ where: { contentItemId: untouched } }),
    ).toBe(0);
  });

  /** 塞げていないと、この投稿が永久にできなくなる */
  it('持ち主はそのあと普通に投稿できる', async () => {
    await wordpress
      .publishDraftForUser(
        {
          userId: bob.userId,
          blogId: bob.blogIds[0],
          contentItemId: untouched,
        },
        INPUT,
        createFactory([]),
      )
      .catch(() => undefined);

    const post = await wordpress.publishDraftForUser(
      {
        userId: alice.userId,
        blogId: alice.blogIds[0],
        contentItemId: untouched,
      },
      INPUT,
      createFactory([]),
    );

    expect(post.blogId).toBe(alice.blogIds[0]);
  });
});
