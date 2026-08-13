import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  listFactIssuesForAdmin,
  recordFactIssueForAdmin,
  summarizeFactIssuesForAdmin,
} from '@/modules/content-generation';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 事実誤認の記録と集計（TASKS J-7、Q-044、SPEC 16.2）。
 *
 * **「承認・公開前に100%検知」を確かめるための分母。**
 * これまで記録されていたのは機械が見つけたものだけだった。
 */

let prisma: PrismaClient;
let versionId: string;
let userId: string;

const FOUND_AT = new Date('2026-08-12T03:00:00.000Z');

async function createArticleVersion(): Promise<string> {
  const blogId = (await createBlog(prisma, userId, { name: 'ブログ' })).id;

  const plan = await prisma.contentPlan.create({
    data: { blogId, planType: 'INITIAL', version: 1, strategySnapshot: {} },
    select: { id: true },
  });

  const item = await prisma.contentItem.create({
    data: {
      contentPlanId: plan.id,
      blogId,
      sequenceNo: 1,
      contentType: 'INFORMATIONAL',
      title: '記事',
      searchIntent: '意図',
      objective: 'TRAFFIC',
      inboundLinkItemIds: [],
      outboundLinkItemIds: [],
      publishPriority: 1,
    },
    select: { id: true },
  });

  const version = await prisma.articleVersion.create({
    data: {
      contentItemId: item.id,
      versionNo: 1,
      title: 'タイトル',
      excerpt: '要約',
      answerCapsule: '結論',
      bodyHtml: '<p>本文</p>',
      faqJson: [],
      structuredDataJson: [],
      factCheckStatus: 'PASSED',
      riskFlags: [],
      usedFactIds: [],
      unverifiedClaims: [],
      modelProvider: 'anthropic',
      modelName: 'test',
      promptVersion: 'v1',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      contentHash: `${item.id}`.padEnd(64, 'x').slice(0, 64),
    },
    select: { id: true },
  });

  return version.id;
}

function record(params: {
  severity?: 'MAJOR' | 'MINOR';
  caughtBeforePublish?: boolean;
  description?: string;
  foundByUserId?: string | null;
}) {
  return recordFactIssueForAdmin({
    articleVersionId: versionId,
    severity: params.severity ?? 'MAJOR',
    description: params.description ?? '価格が誤っていた',
    caughtBeforePublish: params.caughtBeforePublish ?? false,
    foundAt: FOUND_AT,
    foundByUserId: params.foundByUserId ?? null,
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

  userId = (await createUser(prisma)).id;
  versionId = await createArticleVersion();
});

describe('記録する', () => {
  it('保存できる', async () => {
    const issue = await record({});

    expect(issue).toMatchObject({
      severity: 'MAJOR',
      caughtBeforePublish: false,
      description: '価格が誤っていた',
    });
  });

  /** **記録した時刻ではない**（後からまとめて入れうる） */
  it('見つけた日を保存する', async () => {
    expect((await record({})).foundAt.toISOString()).toBe(
      FOUND_AT.toISOString(),
    );
  });

  /** **「何か誤りがあった」だけでは数えられても直せない** */
  it.each(['', '   '])('説明が空なら拒む（%s）', async (description) => {
    await expect(record({ description })).rejects.toThrow();
    expect(await prisma.factIssue.count()).toBe(0);
  });

  /** **外部キー違反をそのまま返すと、画面に出せる文言にならない** */
  it('記事の版が無ければ拒む', async () => {
    await expect(
      recordFactIssueForAdmin({
        articleVersionId: '00000000-0000-0000-0000-000000000000',
        severity: 'MAJOR',
        description: '誤り',
        caughtBeforePublish: false,
        foundAt: FOUND_AT,
        foundByUserId: null,
      }),
    ).rejects.toThrow();
  });

  /** **推測で誰かの名前を入れない**（読者からの指摘など） */
  it('見つけた人が分からなくても保存できる', async () => {
    await record({ foundByUserId: null });

    expect(await prisma.factIssue.count()).toBe(1);
  });

  /**
   * **見つけた人を消しても記録は残す。** 誤りがあった事実は消えない。
   *
   * **見つけた人は、その記事の持ち主とは限らない**（別のモニターや
   * 読者からの指摘）。持ち主を消すと記事の版ごと消えるので、
   * ここで見ているのは**持ち主ではない人**を消した場合である
   */
  it('見つけた人を消しても残る', async () => {
    const finder = await createUser(prisma);

    await record({ foundByUserId: finder.id });
    await prisma.user.delete({ where: { id: finder.id } });

    const rows = await prisma.factIssue.findMany({
      select: { foundByUserId: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.foundByUserId).toBeNull();
  });
});

describe('集計する（SPEC 16.2）', () => {
  /**
   * **1件も無いときに 100% と言わない。** まだ何も起きていないことが
   * 「完璧だった」に見える
   */
  it('1件も無ければ割合を返さない', async () => {
    expect(await summarizeFactIssuesForAdmin()).toMatchObject({
      major: 0,
      rate: null,
    });
  });

  it('公開前に捕まえた割合を出す', async () => {
    await record({ caughtBeforePublish: true });
    await record({ caughtBeforePublish: true });
    await record({ caughtBeforePublish: false });

    expect(await summarizeFactIssuesForAdmin()).toMatchObject({
      major: 3,
      caughtBeforePublish: 2,
    });
  });

  /** **軽微なものを混ぜると、誤字の多さで率が動く** */
  it('軽微なものは割合に入れない', async () => {
    await record({ severity: 'MAJOR', caughtBeforePublish: true });
    await record({ severity: 'MINOR', caughtBeforePublish: false });

    const summary = await summarizeFactIssuesForAdmin();

    expect(summary).toMatchObject({ major: 1, minor: 1, rate: 1 });
  });

  it('全部捕まえていれば100%', async () => {
    await record({ caughtBeforePublish: true });

    expect((await summarizeFactIssuesForAdmin()).rate).toBe(1);
  });

  it('1件も捕まえていなければ0%', async () => {
    await record({ caughtBeforePublish: false });

    expect((await summarizeFactIssuesForAdmin()).rate).toBe(0);
  });
});

/** **直近に何が起きたかを先に見る** */
describe('一覧', () => {
  it('新しい順に並ぶ', async () => {
    await recordFactIssueForAdmin({
      articleVersionId: versionId,
      severity: 'MAJOR',
      description: '古い',
      caughtBeforePublish: false,
      foundAt: new Date('2026-08-01T00:00:00.000Z'),
      foundByUserId: null,
    });
    await record({ description: '新しい' });

    expect(
      (await listFactIssuesForAdmin({})).map((issue) => issue.description),
    ).toEqual(['新しい', '古い']);
  });
});
