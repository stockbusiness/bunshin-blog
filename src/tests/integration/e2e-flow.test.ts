import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createJobHandlers } from '@/app/api/jobs/run/handlers';
import { enqueueArticleGenerationForUser } from '@/app/api/jobs/run/article-schedule';
import { runProposalNotify } from '@/app/api/jobs/run/schedule';
import { enqueueInitialPlansForUser } from '@/app/api/onboarding/initial-plan';
import { createAiProvider } from '@/lib/ai';
import { createLineClient } from '@/lib/line';
import { todayInJst } from '@/lib/datetime';
import { approveForUser, listApprovalsForUser } from '@/modules/approvals';
import { refreshProposalsForUser } from '@/modules/approvals';
import { drainJobs } from '@/modules/jobs';
import { createPromptVersionForAdmin } from '@/modules/content-generation';
import {
  connectWordpressForUser,
  testWordpressConnectionForUser,
  type WordpressClient,
  type WordpressRequest,
} from '@/modules/wordpress';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * SPEC 15.3 の流れを**1本で通す**（TASKS I-5）。
 *
 * ```text
 * モニター登録 → ブログ登録 → WordPress接続 → 案件登録
 *   → 初期記事計画生成 → 記事生成 → LINE通知 → 承認
 *   → WordPress下書き → 状態反映
 * ```
 *
 * ## なぜ要るのか
 *
 * **各タスクの統合テストは、自分の担当だけを見ている。** 棚卸し
 * （2026-08-12）で分かったのは、部品は揃っているのに**誰も呼んでいない**
 * 箇所が5つあったこと（I-1・I-2・I-4・I-8・I-10）。
 *
 * **繋いだことを確かめられるのは、通しで動かしたときだけ。**
 *
 * ## 何を差し替えるか
 *
 * **AI・WordPress・LINE の3つだけ。** ジョブの積み込みも消化も
 * 本番と同じ経路を通る（差し替えると、繋がっていることを確かめられない）。
 */

let prisma: PrismaClient;
let aiServer: Server;
let lineServer: Server;
let aiBaseUrl: string;
let lineBaseUrl: string;
let linePushes: unknown[] = [];

let userId: string;
let blogId: string;
let offerId: string;

const ENV = {
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token-0123456789abcdef',
  LIFF_BASE_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

/** 87字。80〜120字の範囲に入る（SPEC 9.5、E-11） */
const CAPSULE =
  'この記事では、月額500円から使える格安SIMの選び方を、通信速度・料金・サポート体制の3つの観点から比較し、初めて乗り換える方が失敗しないための手順まで具体的に説明します。';

const FAQ = [
  { question: '料金はいくらですか？', answer: '月額500円です' },
  { question: '解約はできますか？', answer: 'いつでもできます' },
  { question: '対応端末は？', answer: '主要な機種に対応しています' },
];

let sequence = 0;

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

/**
 * 1つのサーバーで構成表・記事・主張の抽出すべてに答える。
 *
 * **入力の形で見分ける。** 実際の呼び出しも同じエンドポイントを使う
 * （E-8・E-11・E-12 のテストが個別に持っている判定を1つにまとめた）。
 */
function answerFor(input: Record<string, unknown>): unknown {
  // ── 構成表（E-6〜E-8）─────────────────────────────
  if ('slots' in input) {
    return {
      items: (input['slots'] as { slotId: string }[]).map((slot) => {
        sequence += 1;

        return {
          slotId: slot.slotId,
          title: `収益記事${sequence}`,
          primaryKeyword: `収益キーワード${sequence}`,
          searchIntent: '意図',
        };
      }),
    };
  }

  if ('revenueItems' in input) {
    return {
      intents: (input['revenueItems'] as { itemId: string }[]).flatMap((item) =>
        Array.from({ length: 5 }, (_, index) => ({
          revenueItemId: item.itemId,
          intent: `意図${index}`,
          readerState: '状態',
        })),
      ),
    };
  }

  if ('conflicts' in input) {
    return {
      items: (input['conflicts'] as { intentId: string }[]).map((conflict) => {
        sequence += 1;

        return {
          intentId: conflict.intentId,
          title: `差し替え${sequence}`,
          primaryKeyword: `差し替えキーワード${sequence}`,
        };
      }),
    };
  }

  if ('intents' in input) {
    return {
      items: (input['intents'] as { intentId: string }[]).map((intent) => {
        sequence += 1;

        return {
          intentId: intent.intentId,
          title: `集客記事${sequence}`,
          primaryKeyword: `集客キーワード${sequence}`,
          contentType: 'INFORMATIONAL',
        };
      }),
    };
  }

  // ── 記事（E-11）───────────────────────────────
  if ('contentItem' in input) {
    const links = (input['internalLinks'] ?? []) as { url: string }[];
    const offer = input['offer'] as { affiliateUrl: string } | null;

    return {
      title: '生成されたタイトル',
      excerpt: '要約',
      answerCapsule: CAPSULE,
      bodyHtml: [
        '<p>本記事は広告を含みます。</p>',
        ...links.map((link) => `<a href="${link.url}">内部リンク</a>`),
        offer === null ? '' : `<a href="${offer.affiliateUrl}">公式サイト</a>`,
      ].join(''),
      faq: FAQ,
      usedFactIds: [],
      claims: [],
    };
  }

  // ── 主張の抽出（E-12）。**主張なし＝ PASSED** ──────────
  return { claims: [] };
}

function startAiServer(): Promise<void> {
  aiServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { content: string }[];
      };
      const input = JSON.parse(body.messages[0]?.content ?? '{}') as Record<
        string,
        unknown
      >;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(aiText(answerFor(input)));
    });
  });

  return new Promise((resolve) => {
    aiServer.listen(0, '127.0.0.1', () => {
      const address = aiServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      aiBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function startLineServer(): Promise<void> {
  lineServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      linePushes.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  return new Promise((resolve) => {
    lineServer.listen(0, '127.0.0.1', () => {
      const address = lineServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      lineBaseUrl = `http://127.0.0.1:${port}/push`;
      resolve();
    });
  });
}

/** すべて成功する WordPress を模す */
let nextWpPostId = 4000;

function wordpressResponder(input: WordpressRequest) {
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

  if (method === 'DELETE') {
    return { status: 200, json: { deleted: true } };
  }

  return { status: 200, headers: { allow: 'GET, POST' }, json: [] };
}

function wordpressClientFactory(): WordpressClient {
  return {
    async request(request) {
      const result = wordpressResponder(request);

      return {
        status: result.status,
        headers: result.headers ?? {},
        json: result.json ?? null,
        raw: JSON.stringify(result.json ?? null),
      };
    },
  };
}

function handlers() {
  return createJobHandlers({
    wordpressClientFactory,
    aiProvider: createAiProvider({
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      baseUrl: aiBaseUrl,
    }),
  });
}

/** 溜まっているジョブを最後まで消化する */
async function drainAll(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const result = await drainJobs({
      registry: handlers(),
      deadline: new Date(Date.now() + 60_000),
    });

    expect(result.failed).toBe(0);

    if (result.succeeded === 0) {
      return;
    }
  }
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
  await Promise.all([startAiServer(), startLineServer()]);
});

afterAll(async () => {
  await prisma.$disconnect();
  await Promise.all([
    new Promise<void>((resolve) => aiServer.close(() => resolve())),
    new Promise<void>((resolve) => lineServer.close(() => resolve())),
  ]);
});

beforeEach(async () => {
  await resetDatabase(prisma);
  linePushes = [];
  sequence = 0;
});

/**
 * **1本で通す。** 途中で分けると、「ここまでは動く」が積み重なって
 * 全体が繋がっていないことを見逃す（棚卸しで起きたのがまさにそれ）
 */
it('招待から WordPress の下書きまで通る（SPEC 15.3）', async () => {
  // ── モニター登録（段1〜3）────────────────────────
  const user = await createUser(prisma);
  userId = user.id;

  // ── ブログ登録（段4・5）。分身も一緒に作られる（A-2-R-2c）──
  const blog = await createBlog(prisma, userId, { name: '格安SIMブログ' });
  blogId = blog.id;

  // ── WordPress接続（段6）─────────────────────────
  await connectWordpressForUser(
    { userId, blogId },
    {
      siteUrl: 'https://blog.example.com',
      wpUsername: 'monitor',
      appPassword: 'pass word abcd efgh ijkl mnop',
    },
  );

  const connection = await testWordpressConnectionForUser(
    { userId, blogId },
    wordpressClientFactory,
  );

  expect(connection.ok).toBe(true);

  // ── ジャンル（段7）─────────────────────────────
  const genre = await prisma.genre.create({
    data: {
      name: '節約',
      category: '生活',
      ymylRisk: 'LOW',
      status: 'APPROVED',
    },
    select: { id: true },
  });

  await prisma.blog.update({
    where: { id: blogId },
    data: { genreId: genre.id },
  });

  // ── 案件登録（段8）─────────────────────────────
  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: '格安SIM',
      aspName: 'ASP',
      landingPageUrl: 'https://example.com/lp',
      affiliateUrl: 'https://asp.example/click?a=x',
      // **リンクがある＝提携は承認済み**（Q-060）
      partnershipStatus: 'APPROVED',
      conversionType: 'FREE_SIGNUP',
      rewardYen: 10_000,
      facts: { features: ['機能A'] },
      // **確かめ直した時刻を入れる**（D-13）。入れないと90日判定に
      // 引っかかり、事実チェックが `WARNING` になる。案件を画面から
      // 登録すれば `facts` を渡した時点で入る
      factsUpdatedAt: new Date(),
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  offerId = offer.id;

  // 記事生成に要るプロンプト（E-2）
  await createPromptVersionForAdmin({
    key: 'generation.article',
    version: 'v1',
    body: 'あなたは編集者です。',
    activate: true,
  });
  await createPromptVersionForAdmin({
    key: 'generation.claim_extraction',
    version: 'v1',
    body: '主張を抽出してください。',
    activate: true,
  });

  // ── 初期記事計画生成（I-10 が積み、E-9 が作る）──────────
  const plans = await enqueueInitialPlansForUser(userId);

  expect(plans.queued).toBe(1);

  await drainAll();

  const items = await prisma.contentItem.findMany({
    where: { blogId },
    select: { id: true, publishPriority: true, plannedPublishWeek: true },
    orderBy: { publishPriority: 'asc' },
  });

  // **構成表ができている。** ここが繋がっていなければ以降は動かない
  expect(items.length).toBeGreaterThan(0);
  expect(items[0]?.plannedPublishWeek).toBe(1);

  // ── 記事生成（I-4 が積み、E-10 が作る）────────────────
  const now = new Date();
  const todayJst = todayInJst(now);
  const weekday = new Date(`${todayJst}T00:00:00.000Z`).getUTCDay();

  // **公開する曜日と公開開始日が要る**（I-4）。オンボーディングでは
  // C-9 が割り当てるが、ここでは今日を公開日にして通す
  await prisma.blog.update({
    where: { id: blogId },
    data: {
      status: 'ACTIVE',
      launchDate: new Date(`${todayJst}T00:00:00.000Z`),
      publishWeekdays: [weekday],
    },
  });

  const queued = await enqueueArticleGenerationForUser(userId, { now });

  expect(queued.queued).toBe(1);

  await drainAll();

  const versions = await prisma.articleVersion.findMany({
    select: { id: true, contentItemId: true, factCheckStatus: true },
  });

  expect(versions).toHaveLength(1);
  expect(versions[0]?.factCheckStatus).toBe('PASSED');

  // ── 提案の選定（I-2 が積み、F-1 が選ぶ）───────────────
  const proposals = await refreshProposalsForUser(userId);

  expect(proposals.created).toHaveLength(1);

  // ── LINE通知（I-2 が積み、F-2 が送る）────────────────
  const notified = await runProposalNotify({
    client: createLineClient(
      { channelAccessToken: ENV.LINE_CHANNEL_ACCESS_TOKEN },
      { endpoint: lineBaseUrl },
    ),
    env: ENV,
    now,
  });

  expect(notified.sent).toBe(1);
  expect(linePushes).toHaveLength(1);
  // **本文にブログ名が載る**（どのブログの提案か分からないと判断できない）
  expect(JSON.stringify(linePushes[0])).toContain('格安SIMブログ');

  // ── LIFF確認 → 承認（F-5・F-6）────────────────────
  const [approval] = await listApprovalsForUser(userId, { openOnly: true });

  expect(approval).toBeDefined();

  await approveForUser({
    userId,
    approvalId: approval?.id as string,
  });

  // ── WordPress下書き（F-7 が積み、C-5 が投稿する）──────────
  await drainAll();

  const post = await prisma.wordpressPost.findFirstOrThrow({
    select: { blogId: true, wpStatus: true, contentItemId: true },
  });

  expect(post.blogId).toBe(blogId);
  // **下書きのまま置く。** 公開はモニターが WordPress 側で行う（SPEC 7）
  expect(post.wpStatus).toBe('DRAFT');

  // ── 状態反映 ─────────────────────────────────
  const posted = await prisma.contentItem.findUniqueOrThrow({
    where: { id: post.contentItemId },
    select: { status: true },
  });

  expect(posted.status).toBe('POSTED');

  // **案件が記事に結び付いている**（収益記事の誘導先。SPEC 9.2）
  expect(
    await prisma.contentItem.count({
      where: { blogId, affiliateOfferId: offerId },
    }),
  ).toBeGreaterThan(0);
});
