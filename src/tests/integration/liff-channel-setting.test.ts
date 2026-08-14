import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resetEncryptionKeyCache } from '@/lib/crypto';
import { AppError } from '@/lib/errors';
import { AUTH_ERROR_CODES, verifyLiffIdToken } from '@/modules/auth';
import { saveSettingForAdmin } from '@/modules/settings';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * LINEログインのチャネルIDを**管理画面から**設定できる（Q-046）。
 *
 * **以前は起動必須の環境変数だった。** そのため
 * **LINE のチャネルを作る前にアプリを立てられなかった。**
 * LIFF のエンドポイントにはアプリの公開URLが要るので、
 * **LINE の設定はアプリを立てた後**にしかできない — 鶏と卵になっていた。
 *
 * ここで確かめるのは2つ。
 *
 * 1. **保存した値が実際に使われる**（`process.env` に無くても効く）
 * 2. **未設定が 401 に紛れない** — 紛れると、こちらの設定漏れが
 *    「利用者のトークンがおかしい」に見え、誰も原因に辿り着けない
 */

let prisma: PrismaClient;

const CHANNEL_ID = '2000000001';
const LINE_USER_ID = 'U0123456789abcdef0123456789abcdef';

/** LINE の検証エンドポイントの代わり。渡された `client_id` を控える */
function fakeLine(): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];

  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const clientId = body.get('client_id') ?? '';
    seen.push(clientId);

    const nowSeconds = Math.floor(Date.now() / 1000);

    return new Response(
      JSON.stringify({
        iss: 'https://access.line.me',
        sub: LINE_USER_ID,
        aud: clientId,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);

  process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  resetEncryptionKeyCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);

  // **環境変数側には置かない。** DBの設定だけで動くことを見る
  delete process.env['LINE_LOGIN_CHANNEL_ID'];
});

describe('チャネルIDを管理画面から設定する', () => {
  it('保存した値が検証に使われる', async () => {
    await saveSettingForAdmin({
      key: 'LINE_LOGIN_CHANNEL_ID',
      value: CHANNEL_ID,
      actorUserId: null,
    });

    const line = fakeLine();
    const claims = await verifyLiffIdToken('dummy-token', {
      fetchImpl: line.fetchImpl,
    });

    // LINE へ送った `client_id` が保存した値であること
    expect(line.seen).toEqual([CHANNEL_ID]);
    expect(claims.channelId).toBe(CHANNEL_ID);
    expect(claims.lineUserId).toBe(LINE_USER_ID);
  });

  /**
   * **未設定を「不正なトークン」にしない。**
   * 401 に混ぜると、利用者は何度やり直しても入れず、
   * 管理者は「設定していないだけ」に辿り着けない。
   */
  it('未設定なら 401 ではなく 503 で、専用のコードを返す', async () => {
    const line = fakeLine();

    const error = await verifyLiffIdToken('dummy-token', {
      fetchImpl: line.fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);

    const appError = error as AppError;
    expect(appError.code).toBe(AUTH_ERROR_CODES.liffChannelNotConfigured);
    expect(appError.status).toBe(503);

    // **LINE を呼びに行かない。** 設定が無いのに外へ問い合わせない
    expect(line.seen).toEqual([]);
  });

  /** 空文字が保存されていても「設定済み」にしない */
  it('空白だけの値は未設定として扱う', async () => {
    await prisma.appSetting.create({
      data: { key: 'LINE_LOGIN_CHANNEL_ID', value: '   ', isSecret: false },
    });

    const line = fakeLine();

    const error = await verifyLiffIdToken('dummy-token', {
      fetchImpl: line.fetchImpl,
    }).catch((caught: unknown) => caught);

    expect((error as AppError).code).toBe(
      AUTH_ERROR_CODES.liffChannelNotConfigured,
    );
  });

  /** 明示的に渡された値のほうが優先される（テストと将来の複数チャネル用） */
  it('引数で渡した値は設定より優先される', async () => {
    await saveSettingForAdmin({
      key: 'LINE_LOGIN_CHANNEL_ID',
      value: CHANNEL_ID,
      actorUserId: null,
    });

    const line = fakeLine();
    await verifyLiffIdToken('dummy-token', {
      channelId: '2000000002',
      fetchImpl: line.fetchImpl,
    });

    expect(line.seen).toEqual(['2000000002']);
  });
});
