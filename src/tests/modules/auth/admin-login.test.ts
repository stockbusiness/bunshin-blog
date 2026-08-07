import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import type { Mailer } from '@/lib/mailer';
import {
  AUTH_ERROR_CODES,
  LOGIN_TOKEN_RATE_LIMIT,
  LOGIN_TOKEN_TTL_MINUTES,
  buildLoginMail,
  buildLoginUrl,
  consumeAdminLoginLink,
  createLoginToken,
  hashLoginToken,
  loginTokenExpiry,
  rateWindowStart,
  requestAdminLoginLink,
  verifySessionToken,
  type AdminLoginTokenDb,
  type AdminLoginTokenRecord,
} from '@/modules/auth';
import type { AppUser } from '@/modules/users';

/**
 * 管理者のメール＋ワンタイムリンク（TASKS B-11）。
 *
 * 完了条件のうち **「登録済みADMINのアドレスにだけリンクが届く」
 * 「期限切れ・使用済み・未登録で応答が変わらない」** をここで固定する。
 * 「1回だけ使える」の同時実行は実DBが要るため統合テストに置く。
 */

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-07T12:00:00Z');
const BASE_URL = 'https://example.test';

const ADMIN: AppUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: '運営',
  status: 'ACTIVE',
  termsAcceptedAt: null,
  dataUseConsentAt: null,
};

/** 差し替え可能なトークン置き場 */
function fakeTokens(seed: AdminLoginTokenRecord[] = []) {
  const rows = [...seed];
  const created: { userId: string; tokenHash: string; expiresAt: Date }[] = [];
  const hashes = new Map<string, AdminLoginTokenRecord>();

  const db: AdminLoginTokenDb = {
    create: async (args) => {
      created.push(args);
      const record: AdminLoginTokenRecord = {
        id: `token-${String(rows.length + 1)}`,
        userId: args.userId,
        expiresAt: args.expiresAt,
        usedAt: null,
      };
      rows.push(record);
      hashes.set(args.tokenHash, record);
      return record;
    },
    // **実DBと同じく、引いた時点の写しを返す。** 同じオブジェクトを返すと
    // 片方の更新がもう片方の手元の値にも即座に反映され、競合が起きない
    findByHash: async (tokenHash) => {
      const found = hashes.get(tokenHash);
      return found === undefined ? null : { ...found };
    },
    markUsed: async ({ id, usedAt }) => {
      const target = rows.find((row) => row.id === id);
      if (target === undefined || target.usedAt !== null) {
        return 0;
      }
      target.usedAt = usedAt;
      return 1;
    },
    countIssuedSince: async ({ userId }) =>
      rows.filter((row) => row.userId === userId).length,
  };

  return { db, rows, created, hashes };
}

function fakeMailer() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = {
    send: async (message) => {
      sent.push(message);
    },
  };
  return { mailer, sent };
}

async function catchError(promise: Promise<unknown>): Promise<AppError> {
  return promise.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (thrown: unknown) => thrown as AppError,
  );
}

describe('トークンの生成', () => {
  it('毎回違う値を返す', () => {
    const values = new Set(
      Array.from({ length: 50 }, () => createLoginToken()),
    );

    expect(values.size).toBe(50);
  });

  it('URLに載せられる文字だけを含む', () => {
    expect(createLoginToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('推測できない長さがある（32バイト＝43文字）', () => {
    expect(createLoginToken()).toHaveLength(43);
  });

  it('ハッシュは同じ入力に同じ値を返す', () => {
    expect(hashLoginToken('abc')).toBe(hashLoginToken('abc'));
    expect(hashLoginToken('abc')).not.toBe(hashLoginToken('abd'));
  });

  it('ハッシュから原文が読み取れない', () => {
    const token = createLoginToken();

    expect(hashLoginToken(token)).not.toContain(token);
    expect(hashLoginToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('期限は15分後', () => {
    expect(loginTokenExpiry(NOW).getTime() - NOW.getTime()).toBe(
      LOGIN_TOKEN_TTL_MINUTES * 60 * 1000,
    );
  });

  it('発行数の集計は過去15分', () => {
    expect(NOW.getTime() - rateWindowStart(NOW).getTime()).toBe(15 * 60 * 1000);
  });
});

describe('ログインURL', () => {
  it('検証画面へのリンクを作る', () => {
    expect(buildLoginUrl(BASE_URL, 'tok')).toBe(
      'https://example.test/admin/login/verify?token=tok',
    );
  });

  it('末尾のスラッシュを重ねない', () => {
    expect(buildLoginUrl('https://example.test/', 'tok')).toBe(
      'https://example.test/admin/login/verify?token=tok',
    );
  });

  it('トークンをURLエンコードする', () => {
    expect(buildLoginUrl(BASE_URL, 'a b&c')).toContain('token=a%20b%26c');
  });

  it('本文に有効期限と身に覚えが無い場合の案内を書く', () => {
    const mail = buildLoginMail('https://example.test/x');

    expect(mail.text).toContain('https://example.test/x');
    expect(mail.text).toContain('15 分');
    expect(mail.text).toContain('お心当たりが無い場合');
  });
});

describe('リンクの発行', () => {
  function deps(
    overrides: Partial<Parameters<typeof requestAdminLoginLink>[1]> = {},
  ) {
    const tokens = fakeTokens();
    const mail = fakeMailer();

    return {
      tokens,
      mail,
      options: {
        tokens: tokens.db,
        mailer: mail.mailer,
        baseUrl: BASE_URL,
        now: () => NOW,
        findAdmin: async () => ADMIN,
        ...overrides,
      },
    };
  }

  it('ADMIN にはリンクを送る', async () => {
    const { mail, options } = deps();

    const result = await requestAdminLoginLink('admin@example.test', options);

    expect(result).toEqual({ accepted: true, outcome: 'sent' });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe('admin@example.test');
  });

  it('保存するのはハッシュだけ。原文は保存しない', async () => {
    const { tokens, mail, options } = deps();

    await requestAdminLoginLink('admin@example.test', options);

    const url = mail.sent[0]?.text ?? '';
    const token = /token=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? '';
    expect(token).not.toBe('');

    const stored = tokens.created[0]?.tokenHash ?? '';
    expect(stored).toBe(hashLoginToken(token));
    expect(stored).not.toContain(token);
  });

  it('未登録のアドレスには送らない', async () => {
    const { mail, options } = deps({ findAdmin: async () => null });

    const result = await requestAdminLoginLink('who@example.test', options);

    expect(result.outcome).toBe('unknown-email');
    expect(mail.sent).toHaveLength(0);
  });

  it.each(['PAUSED', 'WITHDRAWN', 'INVITED'] as const)(
    '%s の管理者には送らない',
    async (status) => {
      const { mail, options } = deps({
        findAdmin: async () => ({ ...ADMIN, status }),
      });

      const result = await requestAdminLoginLink('admin@example.test', options);

      expect(result.outcome).toBe('not-active');
      expect(mail.sent).toHaveLength(0);
    },
  );

  it('トークンを発行してから送る（送信できなければ結果に出す）', async () => {
    const failing: Mailer = {
      send: () => Promise.reject(new Error('smtp down')),
    };
    const { options } = deps({ mailer: failing });

    const result = await requestAdminLoginLink('admin@example.test', options);

    expect(result.outcome).toBe('send-failed');
  });

  it('APP_BASE_URL が無ければトークンを発行しない', async () => {
    const { tokens, mail, options } = deps({ baseUrl: '' });

    const result = await requestAdminLoginLink('admin@example.test', options);

    expect(result.outcome).toBe('send-failed');
    expect(tokens.created).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('続けて発行しすぎると送らない', async () => {
    const { mail, options } = deps();

    for (let index = 0; index < LOGIN_TOKEN_RATE_LIMIT; index += 1) {
      await requestAdminLoginLink('admin@example.test', options);
    }
    const result = await requestAdminLoginLink('admin@example.test', options);

    expect(result.outcome).toBe('rate-limited');
    expect(mail.sent).toHaveLength(LOGIN_TOKEN_RATE_LIMIT);
  });

  it('**どの場合も呼び出し側へは同じ形を返す**', async () => {
    const cases = await Promise.all([
      requestAdminLoginLink('a@example.test', deps().options),
      requestAdminLoginLink(
        'b@example.test',
        deps({ findAdmin: async () => null }).options,
      ),
      requestAdminLoginLink(
        'c@example.test',
        deps({ findAdmin: async () => ({ ...ADMIN, status: 'PAUSED' }) })
          .options,
      ),
    ]);

    for (const result of cases) {
      expect(result.accepted).toBe(true);
    }
  });
});

describe('リンクの使用', () => {
  async function issued() {
    const tokens = fakeTokens();
    const mail = fakeMailer();

    await requestAdminLoginLink('admin@example.test', {
      tokens: tokens.db,
      mailer: mail.mailer,
      baseUrl: BASE_URL,
      now: () => NOW,
      findAdmin: async () => ADMIN,
    });

    const url = mail.sent[0]?.text ?? '';
    const token = /token=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? '';

    return { tokens, token };
  }

  it('セッションを発行する', async () => {
    const { tokens, token } = await issued();

    const result = await consumeAdminLoginLink(token, {
      tokens: tokens.db,
      now: () => NOW,
      secret: SECRET,
      findById: async () => ADMIN,
    });

    expect(result.user.id).toBe(ADMIN.id);
    const session = verifySessionToken(result.sessionToken, {
      secret: SECRET,
      now: () => NOW,
    });
    expect(session?.userId).toBe(ADMIN.id);
  });

  it('2回目は使えない', async () => {
    const { tokens, token } = await issued();
    const options = {
      tokens: tokens.db,
      now: () => NOW,
      secret: SECRET,
      findById: async () => ADMIN,
    };

    await consumeAdminLoginLink(token, options);
    const error = await catchError(consumeAdminLoginLink(token, options));

    expect(error.status).toBe(401);
    expect(error.code).toBe(AUTH_ERROR_CODES.invalidLoginLink);
  });

  it('期限が切れていれば使えない', async () => {
    const { tokens, token } = await issued();
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);

    const error = await catchError(
      consumeAdminLoginLink(token, {
        tokens: tokens.db,
        now: () => later,
        secret: SECRET,
        findById: async () => ADMIN,
      }),
    );

    expect(error.status).toBe(401);
  });

  it('発行後に権限を落とされていれば使えない', async () => {
    const { tokens, token } = await issued();

    const error = await catchError(
      consumeAdminLoginLink(token, {
        tokens: tokens.db,
        now: () => NOW,
        secret: SECRET,
        findById: async () => ({ ...ADMIN, role: 'MONITOR' as const }),
      }),
    );

    expect(error.status).toBe(401);
  });

  it('発行後に停止されていれば使えない', async () => {
    const { tokens, token } = await issued();

    const error = await catchError(
      consumeAdminLoginLink(token, {
        tokens: tokens.db,
        now: () => NOW,
        secret: SECRET,
        findById: async () => ({ ...ADMIN, status: 'PAUSED' as const }),
      }),
    );

    expect(error.status).toBe(401);
  });

  it.each(['', '   ', 'not-a-token'])(
    '知らないトークン（%s）は使えない',
    async (token) => {
      const tokens = fakeTokens();

      const error = await catchError(
        consumeAdminLoginLink(token, {
          tokens: tokens.db,
          now: () => NOW,
          secret: SECRET,
          findById: async () => ADMIN,
        }),
      );

      expect(error.status).toBe(401);
    },
  );

  it('**失敗の理由を区別しない**', async () => {
    const { tokens, token } = await issued();
    const options = {
      tokens: tokens.db,
      now: () => NOW,
      secret: SECRET,
      findById: async () => ADMIN,
    };

    await consumeAdminLoginLink(token, options);
    const used = await catchError(consumeAdminLoginLink(token, options));
    const unknown = await catchError(consumeAdminLoginLink('unknown', options));

    expect(used.status).toBe(unknown.status);
    expect(used.code).toBe(unknown.code);
    expect(used.message).toBe(unknown.message);
    expect(used.details).toBeUndefined();
    expect(unknown.details).toBeUndefined();
  });

  it('同時に2回叩かれても片方だけが通る', async () => {
    const { tokens, token } = await issued();
    const options = {
      tokens: tokens.db,
      now: () => NOW,
      secret: SECRET,
      findById: async () => ADMIN,
    };
    const markUsed = vi.spyOn(tokens.db, 'markUsed');

    const results = await Promise.allSettled([
      consumeAdminLoginLink(token, options),
      consumeAdminLoginLink(token, options),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(markUsed).toHaveBeenCalledTimes(2);
  });
});
