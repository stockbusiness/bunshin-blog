import { LIFF_ID_ENV_NAME, readLiffConfig } from './config';

/**
 * LIFF の初期化からセッション確立までの手順（B-8）。
 *
 * **このファイルはブラウザで動く。** サーバー専用のモジュール
 * （`@/lib/env` `@/lib/db` `@/modules/*`）を import してはならない。
 *
 * ```text
 * liff.init() → 未ログインなら liff.login() → getIDToken()
 *   → POST /api/auth/liff（B-1 が検証、B-2 がCookieを発行）
 * ```
 *
 * SDK と `fetch` を引数で受け取る。**LIFF SDK はブラウザ以外で動かないため、
 * 実物に依存したままではこの手順を検証できない。**
 */

/** LIFF SDK のうち、この手順が使う部分だけ */
export interface LiffClient {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(): void;
  getIDToken(): string | null;
}

/** `POST /api/auth/liff` が返す本文のうち、画面が使う部分 */
export interface LiffSessionUser {
  id: string;
  displayName: string;
  role: string;
  status: string;
}

export interface LiffSessionConsents {
  completed: boolean;
  missing: string[];
}

export type LiffBootstrapResult =
  /** セッションが確立した。以降のAPI呼び出しはCookieで通る */
  | {
      status: 'ready';
      user: LiffSessionUser;
      created: boolean;
      consents: LiffSessionConsents;
    }
  /** `liff.login()` を呼んだ。画面遷移するため以降の描画は不要 */
  | { status: 'redirecting' }
  /** `NEXT_PUBLIC_LIFF_ID` が未設定・不正 */
  | { status: 'config-error'; message: string }
  /** `liff.init()` が失敗した。LIFF以外から開いた場合を含む */
  | { status: 'init-error'; message: string }
  /** IDトークンが取れない、またはサーバーが認証を拒否した */
  | { status: 'auth-error'; message: string };

/** 認証に失敗したときに画面へ出す文言。理由は出さない（B-1 の方針） */
const AUTH_FAILED_MESSAGE = 'LINEログインをやり直してください';

const INIT_FAILED_MESSAGE =
  'LIFFの初期化に失敗しました。LINEアプリから開き直してください';

export interface BootstrapLiffSessionOptions {
  liff: LiffClient;
  /** 既定は `globalThis.fetch`。テストから差し替える */
  fetchFn?: typeof fetch;
  /** 既定はビルド時に埋め込まれた値。テストから差し替える */
  env?: Record<string, string | undefined>;
}

/**
 * ビルド時に埋め込まれた `NEXT_PUBLIC_LIFF_ID` を読む。
 *
 * **`process.env.NEXT_PUBLIC_LIFF_ID` と直接書く必要がある。**
 * Next.js はこの形の記述だけを値へ置き換える。`process.env` を
 * オブジェクトとして渡してキーで引くと、ブラウザでは `undefined` になる。
 */
function buildTimeEnv(): Record<string, string | undefined> {
  return { [LIFF_ID_ENV_NAME]: process.env.NEXT_PUBLIC_LIFF_ID };
}

/** セッション確立まで進める。例外を投げず、状態を返す */
export async function bootstrapLiffSession(
  options: BootstrapLiffSessionOptions,
): Promise<LiffBootstrapResult> {
  const { liff } = options;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const env = options.env ?? buildTimeEnv();

  const config = readLiffConfig(env);
  if (!config.ok) {
    return { status: 'config-error', message: config.message };
  }

  try {
    await liff.init({ liffId: config.liffId });
  } catch {
    // 失敗の詳細は画面に出さない。LIFF IDの誤りとネットワーク断で
    // 文言を変えても、利用者が取れる行動は変わらない
    return { status: 'init-error', message: INIT_FAILED_MESSAGE };
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return { status: 'redirecting' };
  }

  const idToken = liff.getIDToken();
  if (idToken === null || idToken === '') {
    // ログイン済みでもIDトークンが無いことがある（スコープ不足など）
    return { status: 'auth-error', message: AUTH_FAILED_MESSAGE };
  }

  return exchangeIdToken(fetchFn, idToken);
}

interface AuthResponseBody {
  user?: LiffSessionUser;
  created?: boolean;
  consents?: LiffSessionConsents;
}

/**
 * IDトークンをセッションCookieに交換する。
 *
 * **IDトークンを保存しない。** 交換したらセッションCookieだけを使う
 * （Cookie は `HttpOnly` なのでスクリプトから読めない）。
 */
async function exchangeIdToken(
  fetchFn: typeof fetch,
  idToken: string,
): Promise<LiffBootstrapResult> {
  let response: Response;

  try {
    response = await fetchFn('/api/auth/liff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
  } catch {
    return {
      status: 'auth-error',
      message: '通信に失敗しました。電波の良い場所で開き直してください',
    };
  }

  if (!response.ok) {
    return { status: 'auth-error', message: AUTH_FAILED_MESSAGE };
  }

  let body: AuthResponseBody;
  try {
    body = (await response.json()) as AuthResponseBody;
  } catch {
    return { status: 'auth-error', message: AUTH_FAILED_MESSAGE };
  }

  const user = body.user;
  if (user === undefined) {
    return { status: 'auth-error', message: AUTH_FAILED_MESSAGE };
  }

  return {
    status: 'ready',
    user,
    created: body.created ?? false,
    consents: body.consents ?? { completed: false, missing: [] },
  };
}
