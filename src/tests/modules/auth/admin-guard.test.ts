import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  AUTH_ERROR_CODES,
  createSessionToken,
  requireAdmin,
  SESSION_COOKIE_NAME,
} from '@/modules/auth';
import type { UsersDb } from '@/modules/users';

/**
 * `/admin` の権限判定（TASKS B-6）。
 *
 * 完了条件「MONITORが `/admin` へアクセスできない」を固定する。
 */

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-07T00:00:00Z');
const CONSENTED_AT = new Date('2026-08-01T00:00:00Z');

interface FakeUserOverrides {
  role?: string;
  status?: string;
  termsAcceptedAt?: Date | null;
  dataUseConsentAt?: Date | null;
}

function fakeDb(overrides: FakeUserOverrides = {}, found = true): UsersDb {
  const record = {
    id: 'user-1',
    role: overrides.role ?? 'ADMIN',
    displayName: '運営',
    status: overrides.status ?? 'ACTIVE',
    termsAcceptedAt:
      overrides.termsAcceptedAt === undefined
        ? CONSENTED_AT
        : overrides.termsAcceptedAt,
    dataUseConsentAt:
      overrides.dataUseConsentAt === undefined
        ? CONSENTED_AT
        : overrides.dataUseConsentAt,
  };

  return {
    findUnique: async () => (found ? record : null),
    findUniqueById: async () => (found ? record : null),
    create: async () => record,
    update: async () => record,
  };
}

function cookie(userId = 'user-1'): string {
  const token = createSessionToken(userId, { secret: SECRET, now: () => NOW });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function options(db: UsersDb) {
  return { secret: SECRET, now: () => NOW, db };
}

/** `requireAdmin` が投げた `AppError` を取り出す */
async function catchError(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as AppError,
  );
}

describe('requireAdmin', () => {
  it('ADMIN を通す', async () => {
    const admin = await requireAdmin(cookie(), options(fakeDb()));

    expect(admin.role).toBe('ADMIN');
    expect(admin.id).toBe('user-1');
  });

  it('MONITOR を 403 で弾く（完了条件）', async () => {
    const error = await catchError(
      requireAdmin(cookie(), options(fakeDb({ role: 'MONITOR' }))),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(403);
    expect(error.code).toBe(AUTH_ERROR_CODES.adminRequired);
  });

  it('セッションが無ければ 401', async () => {
    const error = await catchError(requireAdmin(null, options(fakeDb())));

    expect(error.status).toBe(401);
    expect(error.code).toBe(AUTH_ERROR_CODES.unauthenticated);
  });

  it('署名が違うセッションを弾く', async () => {
    const forged = createSessionToken('user-1', {
      secret: 'b'.repeat(48),
      now: () => NOW,
    });

    const error = await catchError(
      requireAdmin(`${SESSION_COOKIE_NAME}=${forged}`, options(fakeDb())),
    );

    expect(error.status).toBe(401);
  });

  it.each(['PAUSED', 'WITHDRAWN', 'INVITED'])(
    'ADMIN でも %s なら弾く',
    async (status) => {
      const error = await catchError(
        requireAdmin(cookie(), options(fakeDb({ status }))),
      );

      expect(error.status).toBe(403);
      expect(error.code).toBe(AUTH_ERROR_CODES.userNotActive);
    },
  );

  it('DBに居ないユーザーは 401', async () => {
    const error = await catchError(
      requireAdmin(cookie(), options(fakeDb({}, false))),
    );

    expect(error.status).toBe(401);
  });

  it('ロールはCookieではなくDBを見る', async () => {
    // Cookie は同じでも、DB上のロールを落とせば通らなくなる
    const asAdmin = await requireAdmin(cookie(), options(fakeDb()));
    expect(asAdmin.role).toBe('ADMIN');

    const error = await catchError(
      requireAdmin(cookie(), options(fakeDb({ role: 'MONITOR' }))),
    );
    expect(error.status).toBe(403);
  });
});

describe('同意との関係', () => {
  it('同意が無くても ADMIN は通す', async () => {
    // 同意はモニターに求めるもの。運営者を締め出すと、同意周りの
    // 不具合が起きたときに管理画面から直せなくなる
    const admin = await requireAdmin(
      cookie(),
      options(fakeDb({ termsAcceptedAt: null, dataUseConsentAt: null })),
    );

    expect(admin.role).toBe('ADMIN');
  });

  it('同意が揃っていても MONITOR は通さない', async () => {
    const error = await catchError(
      requireAdmin(cookie(), options(fakeDb({ role: 'MONITOR' }))),
    );

    expect(error.code).toBe(AUTH_ERROR_CODES.adminRequired);
  });
});

describe('返すメッセージ', () => {
  it('アカウントの有無を推測させない', async () => {
    const notFound = await catchError(
      requireAdmin(cookie(), options(fakeDb({}, false))),
    );
    const noSession = await catchError(requireAdmin(null, options(fakeDb())));

    // 「そのユーザーは存在しない」と「セッションが無い」を区別させない
    expect(notFound.status).toBe(noSession.status);
    expect(notFound.code).toBe(noSession.code);
    expect(notFound.message).toBe(noSession.message);
  });

  it('MONITOR には権限が無いことだけを伝える', async () => {
    const error = await catchError(
      requireAdmin(cookie(), options(fakeDb({ role: 'MONITOR' }))),
    );

    expect(error.message).toBe('この画面は管理者のみ利用できます');
    expect(error.details).toBeUndefined();
  });
});
