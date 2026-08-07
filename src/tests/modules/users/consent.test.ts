import { describe, expect, it } from 'vitest';
import {
  findOrCreateByLineUserId,
  hasAllConsents,
  isActiveUser,
  missingConsents,
  recordConsent,
  type AppUser,
  type UsersDb,
} from '@/modules/users';

const AT = new Date('2026-08-01T00:00:00Z');
const NOW = new Date('2026-08-07T00:00:00Z');

function user(overrides: Partial<AppUser> = {}): AppUser {
  return {
    id: 'user-1',
    role: 'MONITOR',
    displayName: '田中',
    status: 'ACTIVE',
    termsAcceptedAt: AT,
    dataUseConsentAt: AT,
    ...overrides,
  };
}

describe('hasAllConsents', () => {
  it('両方揃っていれば true', () => {
    expect(hasAllConsents(user())).toBe(true);
  });

  // 片方だけでは足りない
  it('片方だけでは false', () => {
    expect(hasAllConsents(user({ termsAcceptedAt: null }))).toBe(false);
    expect(hasAllConsents(user({ dataUseConsentAt: null }))).toBe(false);
  });
});

describe('missingConsents', () => {
  it('不足している同意を並べる', () => {
    expect(missingConsents(user())).toEqual([]);
    expect(missingConsents(user({ termsAcceptedAt: null }))).toEqual(['terms']);
    expect(
      missingConsents(user({ termsAcceptedAt: null, dataUseConsentAt: null })),
    ).toEqual(['terms', 'dataUse']);
  });
});

describe('isActiveUser', () => {
  it('ACTIVE のみ true', () => {
    expect(isActiveUser(user())).toBe(true);
    for (const status of ['INVITED', 'PAUSED', 'WITHDRAWN'] as const) {
      expect(isActiveUser(user({ status }))).toBe(false);
    }
  });
});

/** DBの代わり。呼ばれた操作を記録する */
function trackingDb(initial: Record<string, unknown> | null) {
  const calls: { op: string; args: unknown }[] = [];
  let record = initial;

  const db: UsersDb = {
    findUnique: async (args) => {
      calls.push({ op: 'findUnique', args });
      return record as never;
    },
    findUniqueById: async (args) => {
      calls.push({ op: 'findUniqueById', args });
      return record as never;
    },
    create: async (args) => {
      calls.push({ op: 'create', args });
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
    update: async (args) => {
      calls.push({ op: 'update', args });
      record = { ...(record ?? {}), ...args.data };
      return record as never;
    },
  };

  return { db, calls, current: () => record };
}

describe('findOrCreateByLineUserId', () => {
  it('既存ユーザーがいれば作らない', async () => {
    const { db, calls } = trackingDb({
      id: 'user-1',
      role: 'MONITOR',
      displayName: '田中',
      status: 'ACTIVE',
      termsAcceptedAt: AT,
      dataUseConsentAt: AT,
    });

    const result = await findOrCreateByLineUserId('U1', '田中', { db });

    expect(result.created).toBe(false);
    expect(result.user.id).toBe('user-1');
    expect(calls.some((c) => c.op === 'create')).toBe(false);
  });

  it('未登録なら作る。同意は空のまま', async () => {
    const { db } = trackingDb(null);

    const result = await findOrCreateByLineUserId('U-new', '新規', { db });

    expect(result.created).toBe(true);
    expect(result.user.termsAcceptedAt).toBe(null);
    expect(result.user.dataUseConsentAt).toBe(null);
  });
});

describe('recordConsent', () => {
  it('同意時刻を記録する', async () => {
    const { db, current } = trackingDb({
      id: 'user-1',
      role: 'MONITOR',
      displayName: '田中',
      status: 'ACTIVE',
      termsAcceptedAt: null,
      dataUseConsentAt: null,
    });

    await recordConsent('user-1', 'terms', { db, now: () => NOW });

    expect(current()?.['termsAcceptedAt']).toEqual(NOW);
  });

  // 同意時刻はデータ利用の根拠になるため、後の操作で書き換えない
  it('同意済みの時刻を上書きしない', async () => {
    const { db, calls } = trackingDb({
      id: 'user-1',
      role: 'MONITOR',
      displayName: '田中',
      status: 'ACTIVE',
      termsAcceptedAt: AT,
      dataUseConsentAt: null,
    });

    const result = await recordConsent('user-1', 'terms', {
      db,
      now: () => NOW,
    });

    expect(result.termsAcceptedAt).toEqual(AT);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('存在しないユーザーには例外を投げる', async () => {
    const { db } = trackingDb(null);

    await expect(recordConsent('missing', 'terms', { db })).rejects.toThrow();
  });
});
