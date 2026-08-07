import { describe, expect, it } from 'vitest';
import {
  authenticateWithLiff,
  LINE_ISSUER,
  verifySessionToken,
} from '@/modules/auth';
import type { UsersDb } from '@/modules/users';

/**
 * LIFF認証の一連の流れ（B-2）。
 *
 * 検証 → ユーザー解決 → セッション発行 が繋がっていることを確かめる。
 */

const CHANNEL_ID = '1234567890';
const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-07T00:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function stubFetch(sub: string, name?: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        iss: LINE_ISSUER,
        sub,
        aud: CHANNEL_ID,
        exp: NOW_SECONDS + 3600,
        iat: NOW_SECONDS - 60,
        ...(name === undefined ? {} : { name }),
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

/** 既存ユーザーの有無を切り替えられる users テーブルの代わり */
interface FakeRecord {
  id: string;
  role: string;
  displayName: string;
  status: string;
  termsAcceptedAt: Date | null;
  dataUseConsentAt: Date | null;
}

function fakeDb(existing: boolean) {
  const calls: string[] = [];
  let record: FakeRecord | null = existing
    ? {
        id: 'existing-user',
        role: 'MONITOR',
        displayName: '既存',
        status: 'ACTIVE',
        termsAcceptedAt: new Date('2026-08-01T00:00:00Z'),
        dataUseConsentAt: new Date('2026-08-01T00:00:00Z'),
      }
    : null;

  const db: UsersDb = {
    findUnique: async () => {
      calls.push('findUnique');
      return record as never;
    },
    findUniqueById: async () => record as never,
    create: async (args) => {
      calls.push('create');
      record = {
        id: 'new-user',
        role: 'MONITOR',
        displayName: args.data.displayName,
        status: 'INVITED',
        termsAcceptedAt: null,
        dataUseConsentAt: null,
      };
      return record as never;
    },
    update: async () => record as never,
  };

  return { db, calls };
}

function run(sub: string, existing: boolean, name?: string) {
  const { db, calls } = fakeDb(existing);

  return {
    calls,
    result: authenticateWithLiff('id.token', {
      channelId: CHANNEL_ID,
      fetchImpl: stubFetch(sub, name),
      secret: SECRET,
      now: () => NOW,
      db,
    }),
  };
}

describe('authenticateWithLiff', () => {
  it('既存ユーザーならそのまま返し、作らない', async () => {
    const { calls, result } = run('U-existing', true);
    const authenticated = await result;

    expect(authenticated.created).toBe(false);
    expect(authenticated.user.id).toBe('existing-user');
    expect(calls).not.toContain('create');
  });

  it('未登録なら作る', async () => {
    const { calls, result } = run('U-new', false, '新規ユーザー');
    const authenticated = await result;

    expect(authenticated.created).toBe(true);
    expect(authenticated.user.displayName).toBe('新規ユーザー');
    expect(calls).toContain('create');
  });

  it('表示名が取れない場合も登録できる', async () => {
    const authenticated = await run('U-noname', false).result;

    expect(authenticated.user.displayName).toBe('モニター');
  });

  it('検証済みユーザーのセッションを発行する', async () => {
    const authenticated = await run('U-existing', true).result;
    const session = verifySessionToken(authenticated.sessionToken, {
      secret: SECRET,
      now: () => NOW,
    });

    expect(session?.userId).toBe('existing-user');
  });

  // SPEC 3.2：クライアント送信のuser_idを信用しない
  it('新規登録の同意は空のまま', async () => {
    const authenticated = await run('U-new', false).result;

    expect(authenticated.user.termsAcceptedAt).toBe(null);
    expect(authenticated.user.dataUseConsentAt).toBe(null);
  });

  it('IDトークンが不正ならユーザーを作らない', async () => {
    const { db, calls } = fakeDb(false);
    const failing = (async () =>
      new Response('{}', { status: 400 })) as unknown as typeof fetch;

    await expect(
      authenticateWithLiff('bad.token', {
        channelId: CHANNEL_ID,
        fetchImpl: failing,
        secret: SECRET,
        now: () => NOW,
        db,
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(calls).toEqual([]);
  });
});
