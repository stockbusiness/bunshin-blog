import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createLogger, type LogEntry } from '@/lib/logger';
import {
  AUTH_ERROR_CODES,
  LINE_ISSUER,
  LINE_VERIFY_ENDPOINT,
  verifyLiffIdToken,
} from '@/modules/auth';

const CHANNEL_ID = '1234567890';
const LINE_USER_ID = 'U4af4980629...';
const NOW = new Date('2026-08-07T00:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: LINE_ISSUER,
    sub: LINE_USER_ID,
    aud: CHANNEL_ID,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 60,
    name: '田中',
    picture: 'https://profile.line-scdn.net/x',
    ...overrides,
  };
}

interface StubOptions {
  status?: number;
  payload?: unknown;
  throws?: unknown;
  invalidJson?: boolean;
}

function stubFetch(options: StubOptions = {}) {
  const calls: { url: string; body: string }[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (options.throws !== undefined) {
      throw options.throws;
    }

    calls.push({ url: String(url), body: String(init?.body ?? '') });

    if (options.invalidJson === true) {
      return new Response('not json', { status: 200 });
    }

    return new Response(JSON.stringify(options.payload ?? validPayload()), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function silentLogger(): {
  logger: ReturnType<typeof createLogger>;
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: createLogger({ sink: (entry) => entries.push(entry) }),
  };
}

function verify(idToken: string, options: StubOptions = {}) {
  const { fetchImpl, calls } = stubFetch(options);
  const { logger, entries } = silentLogger();

  return {
    calls,
    entries,
    result: verifyLiffIdToken(idToken, {
      channelId: CHANNEL_ID,
      fetchImpl,
      now: () => NOW,
      logger,
    }),
  };
}

describe('verifyLiffIdToken', () => {
  it('正当なトークンから line_user_id を取り出す', async () => {
    const claims = await verify('valid.id.token').result;

    expect(claims.lineUserId).toBe(LINE_USER_ID);
    expect(claims.channelId).toBe(CHANNEL_ID);
    expect(claims.displayName).toBe('田中');
    expect(claims.expiresAt.toISOString()).toBe('2026-08-07T01:00:00.000Z');
  });

  it('LINEの検証エンドポイントへ id_token と client_id を送る', async () => {
    const { calls, result } = verify('valid.id.token');
    await result;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LINE_VERIFY_ENDPOINT);
    expect(calls[0]?.body).toContain('id_token=valid.id.token');
    expect(calls[0]?.body).toContain(`client_id=${CHANNEL_ID}`);
  });
});

// B-1 完了条件：改竄トークンを拒否
describe('改竄されたトークンの拒否', () => {
  it('LINEが400を返したら拒否する（署名不正・期限切れ）', async () => {
    await expect(verify('tampered', { status: 400 }).result).rejects.toThrow(
      AppError,
    );
  });

  it('別チャネル向けのトークンを拒否する', async () => {
    // LINE側の検証は通っても、aud が期待するチャネルと違えば拒否する
    const { result } = verify('other.channel.token', {
      payload: validPayload({ aud: '9999999999' }),
    });

    await expect(result).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.invalidIdToken,
      status: 401,
    });
  });

  it('iss が LINE のものでなければ拒否する', async () => {
    const { result } = verify('forged.issuer', {
      payload: validPayload({ iss: 'https://evil.example.com' }),
    });

    await expect(result).rejects.toMatchObject({ status: 401 });
  });

  it('期限切れのトークンを拒否する', async () => {
    const { result } = verify('expired', {
      payload: validPayload({ exp: NOW_SECONDS - 3600 }),
    });

    await expect(result).rejects.toMatchObject({ status: 401 });
  });

  it('発行時刻が未来のトークンを拒否する', async () => {
    const { result } = verify('future', {
      payload: validPayload({ iat: NOW_SECONDS + 3600 }),
    });

    await expect(result).rejects.toMatchObject({ status: 401 });
  });

  it('sub が無いトークンを拒否する', async () => {
    const { result } = verify('no.sub', {
      payload: { ...validPayload(), sub: '' },
    });

    await expect(result).rejects.toMatchObject({ status: 401 });
  });

  it('空のトークンはLINEへ問い合わせずに拒否する', async () => {
    for (const value of ['', '   ']) {
      const { calls, result } = verify(value);
      await expect(result).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(0);
    }
  });

  it('検証結果がJSONでなければ拒否する', async () => {
    await expect(
      verify('weird.response', { invalidJson: true }).result,
    ).rejects.toMatchObject({ status: 401 });
  });

  // わずかな時刻ずれで正当なトークンを弾かない
  it('60秒以内の時刻ずれは許容する', async () => {
    const { result } = verify('just.expired', {
      payload: validPayload({ exp: NOW_SECONDS - 30 }),
    });

    await expect(result).resolves.toMatchObject({ lineUserId: LINE_USER_ID });
  });
});

describe('失敗理由の扱い', () => {
  // 失敗理由を返すと、攻撃者にトークンの改竄結果を教えることになる
  it('クライアントへ返すメッセージに失敗理由を含めない', async () => {
    const { result } = verify('other.channel.token', {
      payload: validPayload({ aud: '9999999999' }),
    });

    await expect(result).rejects.toMatchObject({
      message: '認証に失敗しました',
    });

    const error = await result.then(
      () => undefined,
      (thrown: unknown) => thrown as AppError,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error?.details).toBeUndefined();
    expect(JSON.stringify(error?.details ?? {})).not.toContain('aud');
  });

  it('IDトークンの値をログに出さない', async () => {
    const { entries, result } = verify('super-secret-token-value', {
      status: 400,
    });
    await result.catch(() => undefined);

    expect(JSON.stringify(entries)).not.toContain('super-secret-token-value');
  });
});

describe('LINEへ到達できない場合', () => {
  it('ネットワークエラーは 503 として扱う', async () => {
    const { result } = verify('valid.id.token', {
      throws: new Error('ECONNREFUSED'),
    });

    await expect(result).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.verificationUnavailable,
      status: 503,
    });
  });

  // 5xx を401にすると、LINE障害時に利用者が「認証失敗」と誤解する
  it('LINEの5xxを認証失敗として扱わない', async () => {
    const { result } = verify('valid.id.token', { status: 503 });

    await expect(result).rejects.toMatchObject({ status: 503 });
  });
});

// SPEC 3.2：クライアントが送信したユーザーIDを信用しない
describe('クライアント送信のuser_idを信用しない', () => {
  it('line_user_id はトークンの sub のみを源とする', async () => {
    const claims = await verify('valid.id.token', {
      payload: validPayload({ sub: 'U-from-token' }),
    }).result;

    expect(claims.lineUserId).toBe('U-from-token');
  });

  it('公開インターフェースにユーザーIDを受け取る関数が無い', async () => {
    const authModule = await import('@/modules/auth');
    const exported = Object.keys(authModule);

    // 引数からユーザーを特定する経路を作らせない
    expect(exported).toEqual(
      expect.arrayContaining(['verifyLiffIdToken', 'AUTH_ERROR_CODES']),
    );
    expect(
      exported.filter((name) => /userId|lineUserId/i.test(name)),
    ).toHaveLength(0);
  });
});
