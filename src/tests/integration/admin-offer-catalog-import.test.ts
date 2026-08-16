import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { POST as importCsv } from '@/app/api/admin/offer-catalog/import/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * ASPのCSVを取り込む入口（Q-056）を**実PostgreSQLで**確かめる。
 *
 * 見るのは3つ。
 *
 * 1. **確かめる前に保存しない。** `preview` は読むだけ
 * 2. **足切りが効いている**（SPEC 9.2.3）。数千件を数十件にするのがここ
 * 3. **二度流しても壊れない。** すでに在るものは飛ばす
 *
 * **AIは呼ばない。** 列の対応づけを渡して試す
 * （AIを使う道は `csv-import.test.ts` が持つ）。
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let adminId: string;
let monitorId: string;

function request(userId: string, body: unknown): Request {
  const cookie = buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;

  return new Request('https://example.test/api/admin/offer-catalog/import', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function csv(lines: string[]): string {
  return Buffer.from(lines.join('\n'), 'utf-8').toString('base64');
}

const MAPPING = {
  name: 0,
  rewardYen: 1,
  landingPageUrl: 2,
  conversionType: 3,
  status: 4,
};

const HEADER = '案件名,報酬,リンク先,成果条件,状態';

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

  const admin = await createUser(prisma, { displayName: '管理者' });
  await prisma.user.update({
    where: { id: admin.id },
    data: { role: 'ADMIN' },
  });
  adminId = admin.id;

  const monitor = await createUser(prisma, { displayName: 'モニター' });
  monitorId = monitor.id;
});

describe('ADMIN 以外に開かない', () => {
  it('モニターは取り込めない', async () => {
    const response = await importCsv(
      request(monitorId, {
        action: 'preview',
        csv: csv([HEADER, 'A,1000円,https://a.test/,無料登録,提携中']),
        mapping: MAPPING,
      }),
    );

    expect(response.status).toBe(403);
  });
});

describe('読むだけ（preview）', () => {
  /** **確かめる前に保存しない** */
  it('保存しない', async () => {
    const response = await importCsv(
      request(adminId, {
        action: 'preview',
        csv: csv([HEADER, 'A,1000円,https://a.test/,無料登録,提携中']),
        mapping: MAPPING,
      }),
    );

    expect(response.status).toBe(200);
    expect(await prisma.offerCatalogItem.count()).toBe(0);
  });

  /**
   * **足切りが効いている**（SPEC 9.2.3）。
   * ここが「膨大なデータから選ぶ」を実際に解いている部分。
   */
  it('報酬が足りないものを落とす', async () => {
    const response = await importCsv(
      request(adminId, {
        action: 'preview',
        csv: csv([
          HEADER,
          '通る,1000円,https://ok.test/,無料登録,提携中',
          '安すぎ,700円,https://ng1.test/,無料登録,提携中',
          '購入で安すぎ,2000円,https://ng2.test/,商品購入,提携中',
          '終了,5000円,https://ng3.test/,商品購入,掲載終了',
        ]),
        mapping: MAPPING,
      }),
    );

    const body = (await response.json()) as {
      kept: { name: string }[];
      droppedByReason: Record<string, number>;
      totalRows: number;
    };

    expect(body.totalRows).toBe(4);
    expect(body.kept.map((item) => item.name)).toEqual(['通る']);
    expect(body.droppedByReason).toMatchObject({
      low_reward_free_signup: 1,
      low_reward_purchase: 1,
      ended: 1,
    });
  });

  /** **使えない行を黙って落とさない。** 何件落ちたかを返す */
  it('形が足りない行の理由を数える', async () => {
    const response = await importCsv(
      request(adminId, {
        action: 'preview',
        csv: csv([
          HEADER,
          ',1000円,https://a.test/,無料登録,提携中',
          'B,1000円,ただの文字列,無料登録,提携中',
        ]),
        mapping: MAPPING,
      }),
    );

    const body = (await response.json()) as {
      kept: unknown[];
      droppedByReason: Record<string, number>;
    };

    expect(body.kept).toEqual([]);
    expect(Object.values(body.droppedByReason).reduce((a, b) => a + b, 0)).toBe(
      2,
    );
  });

  /** **一時停止は終了ではない。** 再開したら使える */
  it('一時停止のものは落とすが、終了とは分ける', async () => {
    const response = await importCsv(
      request(adminId, {
        action: 'preview',
        csv: csv([HEADER, 'A,5000円,https://a.test/,商品購入,一時停止']),
        mapping: MAPPING,
      }),
    );

    const body = (await response.json()) as {
      droppedByReason: Record<string, number>;
    };

    expect(body.droppedByReason).toMatchObject({ paused: 1 });
  });

  /** **囲みの中のカンマで列がずれない**（ずれると報酬の欄に名前が入る） */
  it('囲みの中のカンマを壊さない', async () => {
    const response = await importCsv(
      request(adminId, {
        action: 'preview',
        csv: csv([
          HEADER,
          '"A社, B事業部","1,480円",https://a.test/,無料登録,提携中',
        ]),
        mapping: MAPPING,
      }),
    );

    const body = (await response.json()) as {
      kept: { name: string; rewardYen: number }[];
    };

    expect(body.kept[0]).toMatchObject({
      name: 'A社, B事業部',
      rewardYen: 1480,
    });
  });
});

describe('登録する（register）', () => {
  async function register(
    items: Record<string, unknown>[],
  ): Promise<{ added: number; skipped: number }> {
    const response = await importCsv(
      request(adminId, { action: 'register', aspName: 'テストASP', items }),
    );

    return (await response.json()) as { added: number; skipped: number };
  }

  function item(overrides: Record<string, unknown> = {}) {
    return {
      name: 'A社サービス',
      advertiserName: null,
      landingPageUrl: 'https://a.example.com/',
      rewardYen: 1_480,
      conversionType: 'FREE_SIGNUP',
      denyConditions: [],
      ...overrides,
    };
  }

  it('登録できる', async () => {
    expect(await register([item()])).toEqual({ added: 1, skipped: 0 });
    expect(await prisma.offerCatalogItem.count()).toBe(1);
  });

  /**
   * **事実が空のまま入る。** LPから読んで人が確かめるまで
   * 「選べる」にできない（DBの CHECK が守る）。
   */
  it('下書きとして入り、事実は空のまま', async () => {
    await register([item()]);

    const row = await prisma.offerCatalogItem.findFirstOrThrow();

    expect(row.status).toBe('DRAFT');
    expect(row.facts).toEqual([]);
    expect(row.factsUpdatedAt).toBeNull();
  });

  /** **二度流しても壊れない。** すでに在るものは飛ばす */
  it('同じものを二度入れても増えない', async () => {
    await register([item()]);

    expect(await register([item()])).toEqual({ added: 0, skipped: 1 });
    expect(await prisma.offerCatalogItem.count()).toBe(1);
  });

  it('一部が重なっていても、残りは入る', async () => {
    await register([item()]);

    const result = await register([
      item(),
      item({ name: 'B社', landingPageUrl: 'https://b.example.com/' }),
    ]);

    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(await prisma.offerCatalogItem.count()).toBe(2);
  });

  it('モニターは登録できない', async () => {
    const response = await importCsv(
      request(monitorId, {
        action: 'register',
        aspName: 'テストASP',
        items: [item()],
      }),
    );

    expect(response.status).toBe(403);
    expect(await prisma.offerCatalogItem.count()).toBe(0);
  });

  it('1件も無ければ断る', async () => {
    const response = await importCsv(
      request(adminId, { action: 'register', aspName: 'テストASP', items: [] }),
    );

    expect(response.status).toBe(422);
  });
});
