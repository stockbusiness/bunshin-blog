import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAiProvider } from '@/lib/ai';
import {
  PROMPT_ERROR_CODES,
  assertValidJsonLd,
  createPromptVersionForAdmin,
  factCheckArticleForUser,
  generateArticleForUser,
  canSendToApproval,
  listArticleVersionsForUser,
  scanRiskFlagsForUser,
  type FactCheckStatus,
  type JsonLdBlock,
  type RiskFlag,
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

/** 厚みの判定（J-4）が足すコード。**E-13 の検出とは別の話** */
const THICKNESS_CODES = new Set([
  'THIN_BODY',
  'FEW_HEADINGS',
  'NO_FACT_USED',
  'NO_INTERNAL_LINK',
]);

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;
let userId: string;
let blogId: string;
let personaId: string;
let planId: string;
let offerId: string;
let revenueItemId: string;
let trafficItemId: string;

let respond: (input: Record<string, unknown>) => unknown;
/** 主張の抽出（E-12）。既定は「主張なし」＝ `PASSED` */
let respondClaims: (input: Record<string, unknown>) => unknown;

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

      // **記事生成と主張の抽出で入力の形が違う**（CONTENT_PLANNING 7.1 / 8.1）
      const answer =
        input['contentItem'] === undefined
          ? respondClaims(input)
          : respond(input);

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(aiText(answer));
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
  personaId = blog.personaId;

  // **人格が無いと生成できない**（SPEC 5。D-4）。実際の運用でも
  // オンボーディングで必ず登録される。
  //
  // 分身はブログと一緒に作られる（A-2-R-2c）。ここでは
  // **禁止表現（E-13）だけを、このテストが使う語に差し替える**
  const persona = await prisma.persona.findUniqueOrThrow({
    where: { id: blog.personaId },
    select: { identity: true },
  });

  await prisma.persona.update({
    where: { id: blog.personaId },
    data: {
      identity: {
        ...(persona.identity as Record<string, unknown>),
        ngExpressions: ['絶対に'],
      },
    },
  });

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

  const offer = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: '案件',
      aspName: 'ASP',
      landingPageUrl: 'https://example.com/lp',
      affiliateUrl: 'https://asp.example/click?a=x',
      // **リンクがある＝提携は承認済み**（Q-060）
      partnershipStatus: 'APPROVED',
      conversionType: 'FREE_SIGNUP',
      facts: { features: ['機能A'] },
      // **確かめ直した時刻を入れない。** 一度も確かめていない案件の状態
      // （D-13。90日判定に引っかかる）
      denyConditions: [],
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  offerId = offer.id;

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
  respondClaims = () => ({ claims: [] });
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
  it('AI費用が呼び出しごとに記録される', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const logs = await prisma.aiUsageLog.findMany({
      where: { userId },
      select: { operation: true, inputTokens: true },
    });

    // 本文の生成（E-10）と主張の抽出（E-12）で2回
    expect(logs.map((log) => log.operation).sort()).toEqual([
      'generation.article',
      'generation.claim_extraction',
    ]);
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
   * **記事の状態を進めるのは承認依頼の側**（F-4）。
   * 生成の時点で `READY_FOR_REVIEW` にすると、承認依頼の作成に
   * 失敗した記事が「承認待ち」に見える。
   */
  it('検査は済んでいるが状態は進めない', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).not.toBe('NOT_CHECKED');

    const item = await prisma.contentItem.findUnique({
      where: { id: version.contentItemId },
      select: { status: true },
    });

    expect(item?.status).toBe('PLANNED');
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

  /**
   * **収益記事でも `FAQPage` だけ**（E-16・Q-021）。
   *
   * 評点の出どころが無く、作り出せば SPEC 9.6 が禁じる
   * 「根拠のないランキング」になる。評点なしの `Review` は
   * リッチリザルトの対象にもならない
   */
  it('収益記事の JSON-LD も FAQPage だけ', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { structuredDataJson: true },
    });

    const blocks = row?.structuredDataJson as Record<string, unknown>[];

    expect(blocks.map((block) => block['@type'])).toEqual(['FAQPage']);
    // 保存された値のどこにも評点が出ない
    expect(JSON.stringify(blocks)).not.toContain('reviewRating');
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

describe('事実チェック（E-12）', () => {
  /**
   * **チェックを飛ばす経路を作らない。** 別の入口にすると
   * 「呼び忘れた記事」が `NOT_CHECKED` のまま残り、承認画面で
   * 「問題なし」に見える
   */
  it('生成すると必ず事実チェックまで走る', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).not.toBe('NOT_CHECKED');
  });

  it('主張が0件なら PASSED', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('PASSED');
    expect(
      canSendToApproval({
        factCheckStatus: version.factCheckStatus as FactCheckStatus,
        riskFlags: [],
      }),
    ).toBe(true);
  });

  /** **完了条件の「facts外の数値を検出」** */
  it('facts に無い数値を主張したら FAILED', async () => {
    respondClaims = () => ({
      claims: [
        {
          text: '初期費用は3,000円です',
          type: 'PRICE',
          excerpt: '初期費用は3,000円',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('FAILED');

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { unverifiedClaims: true },
    });

    const claims = row?.unverifiedClaims as { reason: string }[];

    expect(claims).toHaveLength(1);
    expect(claims[0]?.reason).toBe('NOT_IN_FACTS');
  });

  /** **FAILED は承認依頼へ送らない**（SPEC 9.7、完了条件） */
  it('FAILED の記事は承認へ送れない', async () => {
    respondClaims = () => ({
      claims: [
        { text: '初月無料です', type: 'CONDITION', excerpt: '初月無料' },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    expect(
      canSendToApproval({
        factCheckStatus: version.factCheckStatus as FactCheckStatus,
        riskFlags: [],
      }),
    ).toBe(false);

    const item = await prisma.contentItem.findUnique({
      where: { id: revenueItemId },
      select: { status: true },
    });

    expect(item?.status).toBe('PLANNED');
  });

  it('GENERAL だけ未確認なら WARNING', async () => {
    respondClaims = () => ({
      claims: [
        { text: '格安SIMは普及しています', type: 'GENERAL', excerpt: '普及' },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('WARNING');
  });

  /** **照合先は案件の facts。** AIの申告ではない */
  it('facts に載っている主張は通る', async () => {
    respondClaims = () => ({
      claims: [
        {
          text: '機能Aが使えます',
          type: 'FEATURE',
          excerpt: '機能Aが使えます',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    // **一度も確かめていない案件なので、一致しても WARNING**（Q-022・D-13）
    expect(version.factCheckStatus).toBe('WARNING');
  });

  /**
   * **90日判定が実際に効くこと**（D-13 の完了条件）。
   *
   * D-13 より前は書き込む経路が無く、**すべての収益記事が WARNING**
   * だった。確かめ直した時刻が入れば通る
   */
  it('確かめ直した案件なら PASSED', async () => {
    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: { factsUpdatedAt: new Date() },
    });

    respondClaims = () => ({
      claims: [
        {
          text: '機能Aが使えます',
          type: 'FEATURE',
          excerpt: '機能Aが使えます',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('PASSED');
  });

  /** **90日を過ぎたら、確かめたことがあっても WARNING**（CONTENT_PLANNING 8.2） */
  it('90日より古ければ WARNING', async () => {
    await prisma.affiliateOffer.update({
      where: { id: offerId },
      data: {
        factsUpdatedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000),
      },
    });

    respondClaims = () => ({
      claims: [
        {
          text: '機能Aが使えます',
          type: 'FEATURE',
          excerpt: '機能Aが使えます',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('WARNING');
  });

  /**
   * **一人称で使ってよい事実だけを照合先にする**（D-6 の制限）。
   * 使ってはいけない事実を根拠に体験談を通したら、制限が無意味になる
   */
  it('使ってはいけない事実を根拠にした体験談は FAILED', async () => {
    await prisma.personaFact.create({
      data: {
        // **記憶は分身に溜まる**（A-2-R-4）。ブログを書く分身に紐づける
        personaId,
        factType: 'EXPERIENCE',
        content: '格安SIMへ乗り換えました',
        source: 'AI_INFERENCE',
        verification: 'UNVERIFIED',
        usableFirstPerson: false,
      },
    });

    respondClaims = () => ({
      claims: [
        {
          text: '私も格安SIMへ乗り換えました',
          type: 'EXPERIENCE',
          excerpt: '乗り換えました',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('FAILED');
  });

  it('使ってよい事実に基づく体験談は通る', async () => {
    await prisma.personaFact.create({
      data: {
        // **記憶は分身に溜まる**（A-2-R-4）。ブログを書く分身に紐づける
        personaId,
        factType: 'EXPERIENCE',
        content: '格安SIMへ乗り換えました',
        source: 'USER_INPUT',
        verification: 'VERIFIED',
        usableFirstPerson: true,
      },
    });

    respondClaims = () => ({
      claims: [
        {
          text: '私も格安SIMへ乗り換えました',
          type: 'EXPERIENCE',
          excerpt: '乗り換えました',
        },
      ],
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    expect(version.factCheckStatus).toBe('PASSED');
  });

  /**
   * **「主張が0件」と「抽出できなかった」を同じ扱いにしない。**
   * 壊れた応答が `PASSED` に化ける
   */
  it('抽出に失敗したら記事を通さない', async () => {
    respondClaims = () => 'これはJSONではありません';

    await expect(
      generateArticleForUser(
        { userId, blogId, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ code: PROMPT_ERROR_CODES.invalidArticle });
  });

  /** 他人のブログの記事はチェックできない（C-6 と同じ形） */
  it('他人のブログIDでは 404', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      factCheckArticleForUser(
        { userId, blogId: otherBlog.id, contentItemId: trafficItemId },
        { provider: provider() },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('禁止表現とリスクフラグ（E-13）', () => {
  /**
   * **飛ばす経路を作らない。** フラグが空のまま残ると、
   * 承認画面で「指摘なし」に見える
   */
  it('生成するとリスクフラグの検査まで走る', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      bodyHtml: `${goodArticle(input).bodyHtml}<p>これは間違いなくおすすめです</p>`,
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { riskFlags: true },
    });

    const flags = row?.riskFlags as { code: string; severity: string }[];

    expect(flags.map((flag) => flag.code)).toContain('ASSERTIVE_CLAIM');
  });

  it('表現に問題が無ければフラグは空', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { riskFlags: true },
    });

    // **厚みの判定（J-4）は別。** この試験の記事は本文が短いので
    // `THIN_BODY` などが立つが、ここで見ているのは E-13 の検出である
    const expressionFlags = (row?.riskFlags as RiskFlag[]).filter(
      (flag) => !THICKNESS_CODES.has(flag.code),
    );

    expect(expressionFlags).toEqual([]);
  });

  /** **本人が禁じた表現は承認を止める**（D-5。人格の設定は `絶対に`） */
  it('NG表現があれば承認へ送れない', async () => {
    respond = (input) => ({
      ...goodArticle(input),
      bodyHtml: `${goodArticle(input).bodyHtml}<p>絶対におすすめです</p>`,
    });

    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { riskFlags: true },
    });

    const flags = row?.riskFlags as RiskFlag[];

    expect(flags.map((flag) => flag.code)).toContain('NG_EXPRESSION');
    expect(
      canSendToApproval({
        factCheckStatus: version.factCheckStatus as FactCheckStatus,
        riskFlags: flags,
      }),
    ).toBe(false);
  });

  /**
   * **PR表記は本文の広告リンクの有無で決まる。** 収益記事は E-10 が
   * 生成の時点で落とすため、ここへは PR表記のある本文しか来ない
   */
  it('収益記事のPR表記があればフラグは付かない', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: revenueItemId },
      { provider: provider() },
    );

    const row = await prisma.articleVersion.findUnique({
      where: { id: version.id },
      select: { riskFlags: true },
    });

    const flags = row?.riskFlags as RiskFlag[];

    expect(flags.map((flag) => flag.code)).not.toContain(
      'PR_DISCLOSURE_MISSING',
    );
  });

  /** 修正依頼（F-6）で本文が書き換わったあとにも掛け直せる */
  it('あとから単独でも掛け直せる', async () => {
    const version = await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    await prisma.articleVersion.update({
      where: { id: version.id },
      data: { bodyHtml: '<p>絶対に治ります</p>' },
    });

    const rescanned = await scanRiskFlagsForUser({
      userId,
      blogId,
      contentItemId: trafficItemId,
    });

    // **表現の検査だけを見る。** 厚みの判定（J-4）も同じ配列に入るが、
    // ここで確かめているのは E-13 の検出である
    const expressionCodes = rescanned.flags
      .map((flag) => flag.code)
      .filter((code) => !THICKNESS_CODES.has(code));

    expect(expressionCodes).toEqual([
      'NG_EXPRESSION',
      'HIGH_RISK_ADVICE',
      'ASSERTIVE_CLAIM',
    ]);
  });

  it('他人のブログIDでは 404', async () => {
    await generateArticleForUser(
      { userId, blogId, contentItemId: trafficItemId },
      { provider: provider() },
    );

    const other = await createUser(prisma);
    const otherBlog = await createBlog(prisma, other.id);

    await expect(
      scanRiskFlagsForUser({
        userId,
        blogId: otherBlog.id,
        contentItemId: trafficItemId,
      }),
    ).rejects.toMatchObject({ status: 404 });
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
