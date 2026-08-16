import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  GET as getRichMenu,
  PUT as putRichMenu,
} from '@/app/api/admin/rich-menu/route';
import {
  GET as getImage,
  PUT as putImage,
} from '@/app/api/admin/rich-menu/image/route';
import { buildSessionCookie, createSessionToken } from '@/modules/auth';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * リッチメニューの入口を**実PostgreSQLで**確かめる（Q-054、TASKS H-6）。
 *
 * 見るのは2つ。
 *
 * 1. **ADMIN 以外に開いていない。** 全モニター共通のものなので、
 *    誰かが変えると全員に出るものが変わる
 * 2. **保存だけでは LINE に出ない。** 適用と分けている
 *
 * **適用（LINEを叩く口）はここで確かめない。** トークンが要るため、
 * 組み立ての試験は `rich-menu.test.ts` が持つ。
 */

const SECRET = 'a'.repeat(48);

let prisma: PrismaClient;
let admin: { id: string };
let monitor: { id: string };

function cookieFor(userId: string): string {
  return buildSessionCookie(
    createSessionToken(userId, { secret: SECRET }),
  ).split(';')[0] as string;
}

function jsonRequest(userId: string, method: string, body?: unknown): Request {
  return new Request('https://example.test/api/admin/rich-menu', {
    method,
    headers: { cookie: cookieFor(userId), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function imageRequest(userId: string, bytes: Uint8Array): Request {
  return new Request('https://example.test/api/admin/rich-menu/image', {
    method: 'PUT',
    headers: { cookie: cookieFor(userId), 'content-type': 'image/png' },
    body: bytes as unknown as BodyInit,
  });
}

/** PNG の頭だけ（`IHDR` に縦横が入っている） */
function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ]);
}

function body(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'BUNSHIN BLOG',
    chatBarText: 'メニュー',
    canvas: 'LARGE',
    selected: true,
    areas: [
      {
        x: 0,
        y: 0,
        width: 1250,
        height: 843,
        label: 'はじめの設定',
        uri: 'https://liff.line.me/1-a/liff/onboarding',
      },
    ],
    ...overrides,
  };
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

  const adminUser = await createUser(prisma, { displayName: '管理者' });
  await prisma.user.update({
    where: { id: adminUser.id },
    data: { role: 'ADMIN' },
  });
  admin = { id: adminUser.id };

  const monitorUser = await createUser(prisma, { displayName: 'モニター' });
  monitor = { id: monitorUser.id };
});

/**
 * **全モニター共通で1つ。** 誰かが変えると全員に出るものが変わるので、
 * ジャンルのマスタと同じくADMINだけに開く。
 */
describe('ADMIN 以外に開かない', () => {
  it('モニターは読めない', async () => {
    const response = await getRichMenu(jsonRequest(monitor.id, 'GET'));

    expect(response.status).toBe(403);
  });

  it('モニターは保存できない', async () => {
    const response = await putRichMenu(jsonRequest(monitor.id, 'PUT', body()));

    expect(response.status).toBe(403);
    expect(await prisma.richMenu.count()).toBe(0);
  });

  it('ログインしていなければ読めない', async () => {
    const response = await getRichMenu(
      new Request('https://example.test/api/admin/rich-menu'),
    );

    expect(response.status).toBe(401);
  });

  it('モニターは画像を上げられない', async () => {
    const response = await putImage(imageRequest(monitor.id, png(2500, 1686)));

    expect(response.status).toBe(403);
  });
});

describe('下書きを保存する', () => {
  it('保存して読み直せる', async () => {
    const saved = await putRichMenu(jsonRequest(admin.id, 'PUT', body()));

    expect(saved.status).toBe(200);

    const response = await getRichMenu(jsonRequest(admin.id, 'GET'));
    const payload = (await response.json()) as {
      richMenu: { name: string; areas: unknown[] };
    };

    expect(payload.richMenu.name).toBe('BUNSHIN BLOG');
    expect(payload.richMenu.areas).toHaveLength(1);
  });

  /** **保存だけでは LINE に出ない。** 適用と分けている */
  it('保存しただけでは未適用のまま', async () => {
    await putRichMenu(jsonRequest(admin.id, 'PUT', body()));

    const response = await getRichMenu(jsonRequest(admin.id, 'GET'));
    const payload = (await response.json()) as {
      richMenu: { lineRichMenuId: string | null };
    };

    expect(payload.richMenu.lineRichMenuId).toBeNull();
  });

  it('何も保存していなくても読める', async () => {
    const response = await getRichMenu(jsonRequest(admin.id, 'GET'));
    const payload = (await response.json()) as {
      richMenu: { areas: unknown[]; hasImage: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.richMenu.areas).toEqual([]);
    expect(payload.richMenu.hasImage).toBe(false);
  });

  /** **LINE に断られる前に断る**（`validateRichMenu`） */
  it('枠からはみ出す配置を断る', async () => {
    const response = await putRichMenu(
      jsonRequest(
        admin.id,
        'PUT',
        body({
          areas: [
            {
              x: 2000,
              y: 0,
              width: 1000,
              height: 843,
              label: 'はみ出す',
              uri: 'https://example.com/',
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await prisma.richMenu.count()).toBe(0);
  });

  it('メニューバーの文字が長すぎれば断る', async () => {
    const response = await putRichMenu(
      jsonRequest(admin.id, 'PUT', body({ chatBarText: 'あ'.repeat(15) })),
    );

    expect(response.status).toBe(422);
  });

  it('https でない行き先を断る', async () => {
    const response = await putRichMenu(
      jsonRequest(
        admin.id,
        'PUT',
        body({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: 'だめ',
              uri: 'http://example.com/',
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(400);
  });
});

describe('画像', () => {
  it('上げて、そのまま返る', async () => {
    const saved = await putImage(imageRequest(admin.id, png(2500, 1686)));

    expect(saved.status).toBe(200);

    const response = await getImage(jsonRequest(admin.id, 'GET'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** **申告を信じない。** `Content-Type` ではなく中身から読む */
  it('PNGでもJPEGでもない中身を断る', async () => {
    const response = await putImage(
      imageRequest(admin.id, Uint8Array.from([0x47, 0x49, 0x46, 0x38])),
    );

    expect(response.status).toBe(400);
  });

  it('空の本文を断る', async () => {
    const response = await putImage(imageRequest(admin.id, new Uint8Array(0)));

    expect(response.status).toBe(422);
  });

  /** **比が違うと、升目と指で押す場所がずれる** */
  it('枠と縦横比が違う画像を断る', async () => {
    await putRichMenu(
      jsonRequest(admin.id, 'PUT', body({ canvas: 'COMPACT' })),
    );

    const response = await putImage(imageRequest(admin.id, png(2500, 1686)));

    expect(response.status).toBe(400);
  });

  it('まだ無ければ 404', async () => {
    const response = await getImage(jsonRequest(admin.id, 'GET'));

    expect(response.status).toBe(404);
  });
});
