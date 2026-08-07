import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  AUTH_ERROR_CODES,
  createSessionToken,
  requireConsentedUser,
  requireUser,
  SESSION_COOKIE_NAME,
} from '@/modules/auth';
import type { UsersDb } from '@/modules/users';

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-07T00:00:00Z');
const CONSENTED_AT = new Date('2026-08-01T00:00:00Z');

interface FakeUserOverrides {
  status?: string;
  termsAcceptedAt?: Date | null;
  dataUseConsentAt?: Date | null;
}

/** users テーブルの代わり。DBを立てずに同意判定を検証する */
function fakeDb(overrides: FakeUserOverrides = {}, found = true): UsersDb {
  const record = {
    id: 'user-1',
    role: 'MONITOR',
    displayName: '田中',
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

describe('requireUser', () => {
  it('有効なセッションからユーザーを返す', async () => {
    const user = await requireUser(cookie(), options(fakeDb()));

    expect(user.id).toBe('user-1');
  });

  it('Cookieが無ければ401', async () => {
    await expect(requireUser(null, options(fakeDb()))).rejects.toMatchObject({
      status: 401,
      code: AUTH_ERROR_CODES.unauthenticated,
    });
  });

  it('署名が合わないセッションは401', async () => {
    await expect(
      requireUser(`${SESSION_COOKIE_NAME}=forged.value`, options(fakeDb())),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('ユーザーが存在しなければ401', async () => {
    await expect(
      requireUser(cookie(), options(fakeDb({}, false))),
    ).rejects.toMatchObject({ status: 401 });
  });

  // 停止したユーザーが古いCookieで通り続けないこと
  it('ACTIVE でないユーザーは403', async () => {
    for (const status of ['INVITED', 'PAUSED', 'WITHDRAWN']) {
      await expect(
        requireUser(cookie(), options(fakeDb({ status }))),
      ).rejects.toMatchObject({
        status: 403,
        code: AUTH_ERROR_CODES.userNotActive,
      });
    }
  });

  it('同意が無くても通す（オンボーディング用）', async () => {
    const user = await requireUser(
      cookie(),
      options(fakeDb({ termsAcceptedAt: null, dataUseConsentAt: null })),
    );

    expect(user.id).toBe('user-1');
  });
});

// B-2 完了条件：同意なしで他APIが403
describe('requireConsentedUser', () => {
  it('両方の同意が揃っていれば通す', async () => {
    const user = await requireConsentedUser(cookie(), options(fakeDb()));

    expect(user.id).toBe('user-1');
  });

  it('利用規約に未同意なら403', async () => {
    await expect(
      requireConsentedUser(
        cookie(),
        options(fakeDb({ termsAcceptedAt: null })),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: AUTH_ERROR_CODES.consentRequired,
    });
  });

  it('データ利用に未同意なら403', async () => {
    await expect(
      requireConsentedUser(
        cookie(),
        options(fakeDb({ dataUseConsentAt: null })),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: AUTH_ERROR_CODES.consentRequired,
    });
  });

  // 片方だけでは足りない
  it('両方が未同意なら403で、不足を両方報告する', async () => {
    const error = await requireConsentedUser(
      cookie(),
      options(fakeDb({ termsAcceptedAt: null, dataUseConsentAt: null })),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as AppError,
    );

    expect(error?.status).toBe(403);
    expect(error?.details?.['missingConsents']).toEqual(['terms', 'dataUse']);
  });

  it('未認証は403ではなく401のまま', async () => {
    await expect(
      requireConsentedUser(null, options(fakeDb())),
    ).rejects.toMatchObject({ status: 401 });
  });
});
