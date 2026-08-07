import { describe, expect, it, vi } from 'vitest';
import {
  LIFF_ID_ENV_NAME,
  bootstrapLiffSession,
  readLiffConfig,
  type LiffClient,
} from '@/lib/liff';

/**
 * LIFF の初期化からセッション確立まで（TASKS B-8）。
 *
 * **実SDKを使わずに手順を固定する。** `@line/liff` はブラウザでしか
 * 動かないため、実物に依存したままでは分岐を検証できない。
 */

const VALID_LIFF_ID = '1234567890-abcdEFGH';

/** テスト用の LIFF SDK。既定は「初期化成功・ログイン済み・トークンあり」 */
function fakeLiff(
  overrides: {
    init?: () => Promise<void>;
    loggedIn?: boolean;
    idToken?: string | null;
  } = {},
): LiffClient & { loginCalls: number } {
  let loginCalls = 0;

  return {
    init: overrides.init ?? ((): Promise<void> => Promise.resolve()),
    isLoggedIn: () => overrides.loggedIn ?? true,
    login: () => {
      loginCalls += 1;
    },
    getIDToken: () =>
      overrides.idToken === undefined ? 'id-token' : overrides.idToken,
    get loginCalls() {
      return loginCalls;
    },
  };
}

/** `POST /api/auth/liff` の応答を作る */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const AUTH_OK_BODY = {
  user: {
    id: 'user-1',
    displayName: 'テスト太郎',
    role: 'MONITOR',
    status: 'ACTIVE',
  },
  created: false,
  consents: { completed: true, missing: [] },
};

const validEnv = { [LIFF_ID_ENV_NAME]: VALID_LIFF_ID };

describe('readLiffConfig', () => {
  it('正しい形式を受け入れる', () => {
    expect(readLiffConfig(validEnv)).toEqual({
      ok: true,
      liffId: VALID_LIFF_ID,
    });
  });

  it('前後の空白を取り除く', () => {
    const result = readLiffConfig({ [LIFF_ID_ENV_NAME]: ` ${VALID_LIFF_ID} ` });

    expect(result).toEqual({ ok: true, liffId: VALID_LIFF_ID });
  });

  it.each([undefined, '', '   '])('未設定（%s）を拒否する', (value) => {
    const result = readLiffConfig({ [LIFF_ID_ENV_NAME]: value });

    expect(result.ok).toBe(false);
  });

  it.each(['abcdefg', '1234567890', '1234567890-', '-abcd', '123_abc'])(
    '形式が不正な %s を拒否する',
    (value) => {
      const result = readLiffConfig({ [LIFF_ID_ENV_NAME]: value });

      expect(result.ok).toBe(false);
    },
  );

  it('メッセージに設定値そのものを含めない', () => {
    const result = readLiffConfig({ [LIFF_ID_ENV_NAME]: 'broken-value-xyz' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('broken-value-xyz');
      expect(result.message).toContain(LIFF_ID_ENV_NAME);
    }
  });
});

describe('bootstrapLiffSession', () => {
  it('セッションが確立すると ready を返す', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, AUTH_OK_BODY));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result).toEqual({
      status: 'ready',
      user: AUTH_OK_BODY.user,
      created: false,
      consents: { completed: true, missing: [] },
    });
  });

  it('IDトークンのみを送る。ユーザーIDを送らない（SPEC 3.2）', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, AUTH_OK_BODY));

    await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/liff');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ idToken: 'id-token' });
  });

  it('未同意でも ready を返し、不足項目を伝える', async () => {
    const body = {
      ...AUTH_OK_BODY,
      consents: { completed: false, missing: ['terms'] },
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, body));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result).toMatchObject({
      status: 'ready',
      consents: { completed: false, missing: ['terms'] },
    });
  });

  it('LIFF IDが未設定なら初期化を試みない', async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn();

    const result = await bootstrapLiffSession({
      liff: fakeLiff({ init }),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: {},
    });

    expect(result.status).toBe('config-error');
    expect(init).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('初期化に失敗すると案内を返す', async () => {
    const result = await bootstrapLiffSession({
      liff: fakeLiff({ init: () => Promise.reject(new Error('boom')) }),
      fetchFn: vi.fn() as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result.status).toBe('init-error');
    if (result.status === 'init-error') {
      expect(result.message).toContain('LINEアプリ');
      // 例外のメッセージをそのまま画面に出さない
      expect(result.message).not.toContain('boom');
    }
  });

  it('未ログインなら login() を呼び、認証APIは叩かない', async () => {
    const liff = fakeLiff({ loggedIn: false });
    const fetchFn = vi.fn();

    const result = await bootstrapLiffSession({
      liff,
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result).toEqual({ status: 'redirecting' });
    expect(liff.loginCalls).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([null, ''])(
    'ログイン済みでもIDトークンが %s なら auth-error',
    async (idToken) => {
      const fetchFn = vi.fn();

      const result = await bootstrapLiffSession({
        liff: fakeLiff({ idToken }),
        fetchFn: fetchFn as unknown as typeof fetch,
        env: validEnv,
      });

      expect(result.status).toBe('auth-error');
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([400, 401, 403, 500, 503])(
    '認証APIが %s を返すと auth-error',
    async (status) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(jsonResponse(status, { error: { code: 'X' } }));

      const result = await bootstrapLiffSession({
        liff: fakeLiff(),
        fetchFn: fetchFn as unknown as typeof fetch,
        env: validEnv,
      });

      expect(result.status).toBe('auth-error');
    },
  );

  it('失敗の理由をクライアントへ出さない（B-1 の方針）', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'AUTH_INVALID_ID_TOKEN', message: '署名が不正です' },
      }),
    );

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result.status).toBe('auth-error');
    if (result.status === 'auth-error') {
      expect(result.message).not.toContain('署名');
      expect(result.message).not.toContain('AUTH_INVALID_ID_TOKEN');
    }
  });

  it('通信に失敗すると、やり直せることを伝える', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('network'));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result.status).toBe('auth-error');
    if (result.status === 'auth-error') {
      expect(result.message).toContain('通信');
    }
  });

  it('本文がJSONでなくても落ちない', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result.status).toBe('auth-error');
  });

  it('200でも user が無ければ ready にしない', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {}));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result.status).toBe('auth-error');
  });

  it('created と consents が欠けていても既定値で ready になる', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { user: AUTH_OK_BODY.user }));

    const result = await bootstrapLiffSession({
      liff: fakeLiff(),
      fetchFn: fetchFn as unknown as typeof fetch,
      env: validEnv,
    });

    expect(result).toEqual({
      status: 'ready',
      user: AUTH_OK_BODY.user,
      created: false,
      consents: { completed: false, missing: [] },
    });
  });
});
