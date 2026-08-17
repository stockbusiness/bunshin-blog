import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { POST as importResults } from '@/app/api/results/import/route';
import { normalizeOfferName } from '@/modules/analytics';
import { createOfferForUser } from '@/modules/affiliate';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createBlog, createUser } from './helpers/factories';

/**
 * 成果CSVの取り込み（Q-059）を**実PostgreSQLで**確かめる。
 *
 * 見るのは4つ。
 *
 * 1. **確かめる前に保存しない。** `preview` は読むだけ
 * 2. **見た内容がそのまま入る**（週ごと・ブログごと）
 * 3. **割り当てが残っていたら書かない。** 書くとその週が「0件」になる
 * 4. **他人のブログへは書けない**（SPEC 14.1）
 *
 * **AIは呼ばない。** 列の対応づけを渡して試す
 * （AIを使う道は `src/lib/csv.ts` の試験が持つ）。
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let userId: string;
let blogId: string;
let otherUserId: string;
let otherBlogId: string;

const MAPPING = { occurredOn: 0, offerName: 1, rewardYen: 2, status: 3 };
const HEADER = '発生日,案件名,報酬額,状態';

function request(userId: string, body: unknown): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api/results/import', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function csv(lines: string[]): string {
  return Buffer.from([HEADER, ...lines].join('\n'), 'utf-8').toString('base64');
}

async function addOffer(
  targetUserId: string,
  targetBlogId: string,
  name: string,
): Promise<void> {
  await createOfferForUser(
    { userId: targetUserId, blogId: targetBlogId },
    {
      name,
      aspName: 'テストASP',
      affiliateUrl: 'https://asp.example.com/click?a=1',
      landingPageUrl: 'https://lp.example.com/a',
      conversionType: 'FREE_SIGNUP',
      rewardYen: 1_480,
      userExperience: 'USED',
    },
  );
}

async function post(userId: string, body: unknown) {
  const response = await importResults(request(userId, body));

  return { status: response.status, body: (await response.json()) as never };
}

beforeAll(async () => {
  process.env['SESSION_SECRET'] = SECRET;
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  const user = await createUser(prisma, { displayName: 'モニター' });
  userId = user.id;
  blogId = (await createBlog(prisma, userId, { name: '節約ブログ' })).id;
  await addOffer(userId, blogId, '格安SIM A');

  const other = await createUser(prisma, { displayName: 'ほかの人' });
  otherUserId = other.id;
  otherBlogId = (await createBlog(prisma, otherUserId)).id;
  await addOffer(otherUserId, otherBlogId, '電力会社B');
});

describe('読むだけ（preview）', () => {
  it('週ごとにまとまって返る', async () => {
    const result = await post(userId, {
      action: 'preview',
      csv: csv(['2026-08-17,格安SIM A,1480,承認']),
      mapping: MAPPING,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      summary: {
        weekStarts: ['2026-08-17'],
        blogs: [{ blogName: '節約ブログ', conversions: 1, revenueYen: 1_480 }],
      },
    });
  });

  /** **確かめる前に保存しない** */
  it('保存しない', async () => {
    await post(userId, {
      action: 'preview',
      csv: csv(['2026-08-17,格安SIM A,1480,承認']),
      mapping: MAPPING,
    });

    expect(await prisma.metricDaily.count()).toBe(0);
  });

  /** **他人の案件名で振り分けない**（見えてはいけない） */
  it('他人の案件は突き合わせに使われない', async () => {
    const result = await post(userId, {
      action: 'preview',
      csv: csv(['2026-08-17,電力会社B,3000,承認']),
      mapping: MAPPING,
    });

    expect(result.body).toMatchObject({
      summary: { unassigned: [{ offerName: '電力会社B' }] },
    });
  });
});

describe('記録する（register）', () => {
  it('見た内容がそのまま入る', async () => {
    const result = await post(userId, {
      action: 'register',
      csv: csv([
        '2026-08-10,格安SIM A,1480,承認',
        '2026-08-17,格安SIM A,1480,承認',
        '2026-08-18,格安SIM A,1480,承認',
      ]),
      mapping: MAPPING,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ savedWeeks: 2 });

    const rows = await prisma.metricDaily.findMany({
      where: { blogId },
      orderBy: { metricDate: 'asc' },
      select: { metricDate: true, conversions: true, revenueYen: true },
    });

    expect(rows).toEqual([
      {
        metricDate: new Date('2026-08-10T00:00:00.000Z'),
        conversions: 1,
        revenueYen: 1_480,
      },
      {
        metricDate: new Date('2026-08-17T00:00:00.000Z'),
        conversions: 2,
        revenueYen: 2_960,
      },
    ]);
  });

  /**
   * **期間の中で成果が無かった週にも0を書く。** 書かないと
   * `metrics_daily` に穴が空き、「0件」と「未報告」が読み分けられない。
   */
  it('間の週に0が入る', async () => {
    await post(userId, {
      action: 'register',
      csv: csv([
        '2026-08-03,格安SIM A,1480,承認',
        '2026-08-17,格安SIM A,1480,承認',
      ]),
      mapping: MAPPING,
    });

    const row = await prisma.metricDaily.findFirstOrThrow({
      where: { blogId, metricDate: new Date('2026-08-10T00:00:00.000Z') },
      select: { conversions: true, revenueYen: true },
    });

    expect(row).toEqual({ conversions: 0, revenueYen: 0 });
  });

  /**
   * **取りこぼしを0件と書かない。** 割り当てが残ったまま書くと、
   * その成果がどこにも入らないまま「その週は0件だった」と記録される。
   */
  it('割り当てが残っていたら書かない', async () => {
    const result = await post(userId, {
      action: 'register',
      csv: csv(['2026-08-17,知らない案件,1480,承認']),
      mapping: MAPPING,
    });

    expect(result.status).toBe(422);
    expect(await prisma.metricDaily.count()).toBe(0);
  });

  it('選べば入る', async () => {
    const result = await post(userId, {
      action: 'register',
      csv: csv(['2026-08-17,知らない案件,1480,承認']),
      mapping: MAPPING,
      assignments: { [normalizeOfferName('知らない案件')]: blogId },
    });

    expect(result.status).toBe(200);

    const row = await prisma.metricDaily.findFirstOrThrow({
      where: { blogId },
      select: { conversions: true, revenueYen: true },
    });

    expect(row).toEqual({ conversions: 1, revenueYen: 1_480 });
  });

  /** **実験の外のサイトの成果を混ぜない**（ASPの契約はユーザー単位） */
  it('「数えない」を選べば0のまま記録される', async () => {
    await post(userId, {
      action: 'register',
      csv: csv(['2026-08-17,知らない案件,1480,承認']),
      mapping: MAPPING,
      assignments: { [normalizeOfferName('知らない案件')]: 'NONE' },
    });

    const row = await prisma.metricDaily.findFirstOrThrow({
      where: { blogId },
      select: { conversions: true, revenueYen: true },
    });

    expect(row).toEqual({ conversions: 0, revenueYen: 0 });
  });

  /**
   * **他人のブログを指しても書けない**（SPEC 14.1）。
   * `saveWeeklyResultForUser` が所有権を見るが、**その手前で断る。**
   */
  it('他人のブログへは割り当てられない', async () => {
    const result = await post(userId, {
      action: 'register',
      csv: csv(['2026-08-17,知らない案件,1480,承認']),
      mapping: MAPPING,
      assignments: { [normalizeOfferName('知らない案件')]: otherBlogId },
    });

    expect(result.status).toBe(422);
    expect(await prisma.metricDaily.count()).toBe(0);
  });

  it('日付が1つも読めなければ断る', async () => {
    const result = await post(userId, {
      action: 'register',
      csv: csv(['未確定,格安SIM A,1480,承認']),
      mapping: MAPPING,
    });

    expect(result.status).toBe(422);
    expect(await prisma.metricDaily.count()).toBe(0);
  });

  /** **同じCSVを二度流しても増えない**（上書きになる） */
  it('二度流しても増えない', async () => {
    const body = {
      action: 'register',
      csv: csv(['2026-08-17,格安SIM A,1480,承認']),
      mapping: MAPPING,
    };

    await post(userId, body);
    await post(userId, body);

    const rows = await prisma.metricDaily.findMany({ where: { blogId } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversions).toBe(1);
  });
});

describe('ログインしていないとき', () => {
  it('断る', async () => {
    const response = await importResults(
      new Request('https://example.test/api/results/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'preview', csv: csv([]) }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
