import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import {
  PROMPT_ERROR_CODES,
  assertValidJsonLd,
  createPromptVersionForAdmin,
  generateArticleForUser,
  listArticleVersionsForUser,
  type JsonLdBlock,
} from '@/modules/content-generation';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 記事生成を**実PostgreSQL・実HTTPサーバーで**確かめる（TASKS E-10）。
 *
 * 完了条件は「**構成表を参照して生成。単体生成モードを作らない**」。
 *
 * あわせて CONTENT_PLANNING 7.2 の「プロンプトに明記し、**かつ受信後に
 * コードで検査する**」を確かめる — AIが制約を破った応答を返しても
 * 保存されないこと。
 */

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;
let planId: string;
let revenueItemId: string;
let trafficItemId: string;

let respond: (input: Record<string, unknown>) => unknown;

function aiText(payload: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 200 },
  });
}

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const raw = (body as { messages: { content: string }[] }).messages[0]
        ?.content;
      const input = JSON.parse(raw ?? '{}') as Record<string, unknown>;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(aiText(respond(input)));
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

/** 87字。80〜120字の範囲に入る（SPEC 9.5、E-11） */
const CAPSULE =
  'この記事では、月額500円から使える格安SIMの選び方を、通信速度・料金・サポート体制の3つの観点から比較し、初めて乗り換える方が失敗しないための手順まで具体的に説明します。';

/** 3件。疑問形（SPEC 9.5「3〜5問」） */
const FAQ = [
  { question: '料金はいくらですか？', answer: '月額500円です' },
  { question: '解約はできますか？', answer: 'いつでもできます' },
  { question: '対応端末は？', answer: '主要な機種に対応しています' },
];

/** 内部リンクを1本だけ含む、素直な記事 */
function goodArticle(input: Record<string, unknown>) {
  const links = (input['internalLinks'] ?? []) as { url: string }[];
  const offer = input['offer'] as { affiliateUrl: string } | null;

  const body = [
    '<p>本記事は広告を含みます。</p>',
    ...links.map((link) => `<a href="${link.url}">内部リンク</a>`),
    offer === null ? '' : `<a href="${offer.affiliateUrl}">公式サイト</a>`,
  ].join('');

  return {
    title: '生成されたタイトル',
    excerpt: '要約',
    answerCapsule: CAPSULE,
    bodyHtml: body,
    faq: FAQ,
    usedFactIds: [],
    claims: [{ text: '主張', source: 'general' }],
  };
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

  // **人格が無いと生成できない**（SPEC 5。D-4）。実際の運用でも
  // オンボーディングで必ず登録される
  await prisma.userPersona.create({
    data: {
      userId,
      baseProfile: { age: '30代', occupation: '会社員' },
      tone: { politeness: 'desu_masu' },
      values: { priorities: ['節約'] },
      ngExpressions: ['絶対に'],
    },
  });

  await createPromptVersionForAdmin({
    key: 'generation.article',
    version: 'v1',
    body: 'あなたは編集者です。',
    activate: true,
  });

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://example.com/lp',
      affiliateUrl: 'https://asp.example/click?a=x',
      conversionType: 'FREE_SIGNUP',
      facts: { features: ['機能A'] },
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  const plan = await prisma.contentPlan.create({
    data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });
  planId = plan.id;

  const revenue = await prisma.contentItem.create({
    data: {
      contentPlanId: planId,
      blogId,
      sequenceNo: 1,
      contentType: 'AFFILIATE',
      title: '収益記事',
      primaryKeyword: '収益キーワード',
      searchIntent: '意図',
      objective: 'REVENUE',
      affiliateOfferId: offer.id,
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: 1,
    },
    select: { id: true },
  });
  revenueItemId = revenue.id;

  const traffic = await prisma.contentItem.create({
    data: {
      contentPlanId: planId,
      blogId,
      sequenceNo: 2,
      contentType: 'INFORMATIONAL',
      title: '集客記事',
      primaryKeyword: '集客キーワード',
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [revenue.id],
      publishPriority: 2,
    },
    select: { id: true },
  });
  trafficItemId = traffic.id;

  respond = goodArticle;
});

describe('構成表を参照して生成する（完了条件）', () => {
  it('記事の版が保存される', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.versionNo).toBe(1);
    expect(version.title).toBe('生成されたタイトル');
    expect(version.contentHash).toHaveLength(64);
  });

  /** **単体生成モードを作らない。** 構成表に無い記事IDは通らない */
  it('構成表に無い記事は生成できない', async () => {
    await expect(
      generateArticleForUser(
        {
          userId,
          blogId,
          contentItemId: '00000000-0000-4000-8000-000000000000',
        },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({
      code: PROMPT_ERROR_CODES.itemNotInPlan,
      status: 404,
    });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /** **内部リンクは構成表から取る。** AIに選ばせない */
  it('内部リンクは outbound_link_item_ids から渡す', async () => {
    let received: Record<string, unknown> = {};
    respond = (input) => {
      received = input;
      return goodArticle(input);
    };

    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const links = received['internalLinks'] as { itemId: string }[];

    expect(links).toHaveLength(1);
    expect(links[0]?.itemId).toBe(revenueItemId);
  });

  it('再生成すると版が増える', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );
    const second = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(second.versionNo).toBe(2);

    const versions = await listArticleVersionsForUser({
      userId,
      blogId,
      contentItemId: trafficItemId,
    });

    expect(versions.map((entry) => entry.versionNo)).toEqual([2, 1]);
  });

  /** 費用は必ず記録する（E-14）。予算の判定もここで走る（E-15） */
  it('AI費用が記録される', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const logs = await prisma.aiUsageLog.findMany({
      where: { userId },
      select: { operation: true, inputTokens: true, outputTokens: true },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.operation).toBe('generation.article');
    expect(logs[0]?.inputTokens).toBe(100);
  });
});

describe('受信後の検査（CONTENT_PLANNING 7.2）', () => {
  /** **プロンプトに書いただけでは守られない** */
  it('許可されていないリンクを含む記事は保存しない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      bodyHtml:
        '<p>本記事は広告を含みます。</p><a href="https://evil.example">外部</a>',
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /** SPEC 15.2。広告リンクがあるのにPR表記が無い */
  it('PR表記の無い収益記事は保存しない', async () => {
    respond = (input) => {
      const offer = input['offer'] as { affiliateUrl: string } | null;

      return {
        ...goodArticle(input),
        bodyHtml: `<a href="${offer?.affiliateUrl ?? ''}">公式</a>`,
      };
    };

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: revenueItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  it('渡していない事実を使ったと言われたら保存しない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      usedFactIds: ['00000000-0000-4000-8000-000000000000'],
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /** JSONにならなければ1回だけやり直す（CONTENT_PLANNING 1.2） */
  it('壊れた応答は保存しない', async () => {
    respond = () => 'これはJSONではありません';

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });
  });
});

describe('生成しただけでは承認へ送れない', () => {
  /**
   * **事実チェック（E-12）と禁止表現の検査（E-13）を通っていない。**
   * この時点で `READY_FOR_REVIEW` にすると、未検査の記事が承認依頼へ流れる。
   */
  it('事実チェックは未実施のまま保存される', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { factCheckStatus: true, riskFlags: true },
    });

    expect(row?.factCheckStatus).toBe('NOT_CHECKED');
    // 禁止表現・リスクフラグは E-13
    expect(row?.riskFlags).toEqual([]);
  });

  it('記事の状態は PLANNED のまま', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const item = await prisma.contentItem.findUnique({
      where: { id: trafficItemId },
      select: { status: true },
    });

    expect(item?.status).toBe('PLANNED');
  });
});

describe('アンサーカプセルとJSON-LD（E-11）', () => {
  /** **結論を置く位置をAIに任せない。** タイトルがH1なので本文の先頭＝H1直後 */
  it('本文の先頭にアンサーカプセルが入る', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.bodyHtml.startsWith('<p class="answer-capsule">')).toBe(
      true,
    );
    expect(version.bodyHtml).toContain(CAPSULE);
    expect(version.answerCapsule).toBe(CAPSULE);
  });

  /** **80〜120字の範囲外なら作り直す**（CONTENT_PLANNING 7.2） */
  it('短いカプセルは作り直し、2回目が通れば保存される', async () => {
    let calls = 0;
    respond = (input) => {
      calls += 1;

      return calls === 1
        ? { ...goodArticle(input), answerCapsule: '短い結論です。' }
        : goodArticle(input);
    };

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(calls).toBe(2);
    expect(version.answerCapsule).toBe(CAPSULE);
  });

  /** **2回とも範囲外なら落とす。** 暫定の記事を残さない */
  it('作り直しても範囲外なら保存しない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      answerCapsule: '短い結論です。',
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /**
   * **失敗した試行にも費用がかかる**（CONTENT_PLANNING 9
   * 「再生成ループの各試行も個別に記録する」）
   */
  it('作り直した分の費用も記録される', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      answerCapsule: '短い結論です。',
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(2);
  });

  it('FAQ が3件未満なら保存しない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      faq: [{ question: '料金は？', answer: '月額500円です' }],
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /** **H1は記事タイトルが担う** */
  it('本文に h1 を書いたら保存しない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      bodyHtml: `<h1>見出し</h1>${goodArticle(input).bodyHtml}`,
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });

    expect(await prisma.articleVersion.count()).toBe(0);
  });

  /** **AIに生成させない**（CONTENT_PLANNING 7.3） */
  it('集客記事の JSON-LD は FAQPage だけ', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { structuredDataJson: true },
    });

    const blocks = row?.structuredDataJson as Record<string, unknown>[];

    expect(blocks.map((block) => block['@type'])).toEqual(['FAQPage']);
    expect(blocks[0]?.['mainEntity']).toHaveLength(FAQ.length);
  });

  it('収益記事の JSON-LD は FAQPage と Review', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { structuredDataJson: true },
    });

    const blocks = row?.structuredDataJson as Record<string, unknown>[];

    expect(blocks.map((block) => block['@type'])).toEqual([
      'FAQPage',
      'Review',
    ]);
    // **案件名は `affiliate_offers.name` から取る。** AIの申告ではない
    expect(blocks[1]?.['itemReviewed']).toEqual({
      '@type': 'Product',
      name: '案件',
    });
  });

  /** 保存された値がそのまま JSON として読めること（完了条件） */
  it('保存された JSON-LD は構文的に妥当', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { structuredDataJson: true },
    });

    expect(() =>
      assertValidJsonLd(row?.structuredDataJson as JsonLdBlock[]),
    ).not.toThrow();
  });

  /** **案件の事実をAIへ渡す**（SPEC 9.6 の「offer.facts に無いことを書かない」） */
  it('案件名と facts が生成の入力に入る', async () => {
    let received: Record<string, unknown> = {};
    respond = (input) => {
      received = input;

      return goodArticle(input);
    };

    await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    expect(received['offer']).toMatchObject({
      name: '案件',
      facts: { features: ['機能A'] },
    });
  });
});

describe('他人の記事は生成できない', () => {
  it('他人のブログIDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      generateArticleForUser(
        { userId, blogId: otherBlog.id, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  /** **`contentItemId` は呼び出し側から渡ってくる**（C-6 と同じ形） */
  it('自分のブログID + 他人の記事IDでは 404', async () => {
    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);
    const otherPlan = await prisma.contentPlan.create({
      data: {
        blogId: otherBlog.id,
        planType: 'INITIAL',
        version: 1,
        strategySnapshot: {},
      },
      select: { id: true },
    });
    const otherItem = await prisma.contentItem.create({
      data: {
        contentPlanId: otherPlan.id,
        blogId: otherBlog.id,
        sequenceNo: 1,
        contentType: 'INFORMATIONAL',
        title: '他人の記事',
        searchIntent: '意図',
        objective: 'TRAFFIC',
        inboundLinkItemIds: [],
        outboundLinkItemIds: [],
        publishPriority: 1,
      },
      select: { id: true },
    });

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: otherItem.id },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.itemNotInPlan });

    expect(await prisma.articleVersion.count()).toBe(0);
  });
});
