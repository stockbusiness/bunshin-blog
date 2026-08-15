import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { POST as reviewGenre } from '@/app/api/admin/blogs/[blogId]/genre-review/route';
import { POST as addGenre } from '@/app/api/admin/genres/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import { createBlogForUser, requireBlogForUser } from '@/modules/blogs';
import { createOfferForUser } from '@/modules/affiliate';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createPersona, createUser } from './helpers/factories';

/**
 * ジャンル審査の入口を**実PostgreSQLで**確かめる（Q-049、E-4、SPEC 9.2.2）。
 *
 * **ここが「停止条件を満たすジャンルが通過しない」の最後の砦**である。
 * 判定は `judgeGenre` が持つが、**通っていないのに割り当ててしまえば
 * 判定は意味を失う。** そこを見張る。
 *
 * **AIは呼ばない。** 説明文と候補は判定に関わらず、呼べなくても
 * 判定と記録は残る（`service.ts`）。ここで確かめるのは可否と割り当て。
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let admin: { id: string };
let monitor: { id: string };
let blogId: string;

function request(userId: string, body?: unknown): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 個人ブログが多く、大手が少ない内訳（停止も警告もしない） */
function healthySerp(): { domainType: string }[] {
  return [
    ...Array.from({ length: 6 }, () => ({ domainType: 'personal' })),
    ...Array.from({ length: 4 }, () => ({ domainType: 'other' })),
  ];
}

async function createGenreVia(input: {
  name: string;
  category: string;
  ymylRisk: string;
}): Promise<string> {
  const response = await addGenre(request(admin.id, input));
  const body = (await response.json()) as { genre: { id: string } };

  expect(response.status).toBe(201);

  return body.genre.id;
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

  // **`createUser` は role を受け取らない。** ADMIN は直に作る
  const created = await createUser(prisma, { displayName: '管理者' });
  await prisma.user.update({
    where: { id: created.id },
    data: { role: 'ADMIN' },
  });
  admin = created;

  monitor = await createUser(prisma);

  const persona = await createPersona(prisma, monitor.id);
  const blog = await createBlogForUser(monitor.id, {
    personaId: persona.id,
    name: 'ブログ',
    slug: 'blog',
    targetReader: '読者',
  });

  blogId = blog.id;

  // **案件0件は停止条件**（`noOffers`）。通る筋を確かめるために先に入れる。
  // **1件だけだと警告になる**（`singleOffer`）ので、既定は2件
  await addOffer('格安SIM案件A');
  await addOffer('格安SIM案件B');
});

async function addOffer(name: string): Promise<void> {
  await createOfferForUser(
    { userId: monitor.id, blogId },
    {
      name,
      aspName: 'サンプルASP',
      landingPageUrl: 'https://lp.example.com/offer',
      affiliateUrl: 'https://asp.example/click?a=xxxx',
      conversionType: 'FREE_SIGNUP',
    },
  );
}

describe('通ったら割り当てる', () => {
  it('停止条件に当たらなければ、ブログにジャンルが付く', async () => {
    const genreId = await createGenreVia({
      name: '格安SIM',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: healthySerp(),
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );
    const body = (await response.json()) as {
      decision: string;
      genre: { name: string } | null;
    };

    expect(response.status).toBe(200);
    expect(body.decision).toBe('PASSED');
    expect(body.genre).toMatchObject({ name: '格安SIM' });

    const blog = await requireBlogForUser({ userId: monitor.id, blogId });

    expect(blog.genre).toMatchObject({ name: '格安SIM' });
  });

  /**
   * **警告は「進めるが利用者に明示する」**（SPEC 9.2.2）。止めない。
   *
   * **案件が1件だけのモニターは、ここに必ず来る。** 段8で1件だけ
   * 登録して段7へ進むのが自然な順路なので、**通常の経路である。**
   */
  it('案件が1件だけなら警告つきで通り、ジャンルは付く', async () => {
    await prisma.affiliateOffer.deleteMany({ where: { blogId } });
    await addOffer('唯一の案件');

    const genreId = await createGenreVia({
      name: '光回線',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: healthySerp(),
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );
    const body = (await response.json()) as {
      decision: string;
      reasons: string[];
      genre: { name: string } | null;
    };

    expect(body.decision).toBe('WARNED');
    expect(body.reasons).toContain('single_offer');
    expect(body.genre).toMatchObject({ name: '光回線' });
  });
});

/**
 * **止まったら付けない。** 付けると、停止条件を満たすジャンルで
 * ブログが動き出す — E-4 の完了条件がそこで壊れる。
 */
describe('止まったら割り当てない', () => {
  it('YMYL のジャンルは付かない', async () => {
    const genreId = await createGenreVia({
      name: 'つみたてNISA',
      category: '投資・資産運用',
      ymylRisk: 'HIGH',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: healthySerp(),
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );
    const body = (await response.json()) as {
      decision: string;
      reasons: string[];
      genre: unknown;
    };

    expect(body.decision).toBe('BLOCKED');
    expect(body.reasons).toContain('ymyl_high');
    expect(body.genre).toBeNull();

    const blog = await requireBlogForUser({ userId: monitor.id, blogId });

    expect(blog.genre).toBeNull();
  });

  it('検索上位を大手が占めていれば付かない', async () => {
    const genreId = await createGenreVia({
      name: 'クレジットカード比較',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: [
          ...Array.from({ length: 8 }, () => ({
            domainType: 'major_comparison',
          })),
          ...Array.from({ length: 2 }, () => ({ domainType: 'personal' })),
        ],
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );
    const body = (await response.json()) as {
      decision: string;
      genre: unknown;
    };

    expect(body.decision).toBe('BLOCKED');
    expect(body.genre).toBeNull();
  });
});

/**
 * **空を「該当なし」として通さない**（CONTENT_PLANNING 2.1）。
 * 取得できないことを理由に停止条件を飛ばすと、大手が占めるジャンルが
 * 検索の不調のたびに通る。
 */
describe('入力を確かめる', () => {
  it('検索上位が空なら受け付けない', async () => {
    const genreId = await createGenreVia({
      name: '光回線',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: [],
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );

    expect(response.status).toBe(422);
  });

  it('無いブログは 404', async () => {
    const genreId = await createGenreVia({
      name: 'ふるさと納税',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(admin.id, {
        genreId,
        serpTop10: healthySerp(),
        userHasExperience: true,
      }),
      {
        params: Promise.resolve({
          blogId: '00000000-0000-0000-0000-000000000000',
        }),
      },
    );

    expect(response.status).toBe(404);
  });
});

/**
 * **モニターに開かない。** `ymylRisk` を自己申告にすると、
 * 停止条件を申告で回避できる。
 */
describe('ADMIN だけ', () => {
  it('モニターはジャンルを足せない', async () => {
    const response = await addGenre(
      request(monitor.id, {
        name: '自己申告ジャンル',
        category: '通信',
        ymylRisk: 'LOW',
      }),
    );

    expect(response.status).toBe(403);
  });

  it('モニターは審査を回せない', async () => {
    const genreId = await createGenreVia({
      name: 'ウォーターサーバー',
      category: '通信',
      ymylRisk: 'LOW',
    });

    const response = await reviewGenre(
      request(monitor.id, {
        genreId,
        serpTop10: healthySerp(),
        userHasExperience: true,
      }),
      { params: Promise.resolve({ blogId }) },
    );

    expect(response.status).toBe(403);
  });
});
