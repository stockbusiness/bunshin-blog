/**
 * 接続テスト（TASKS H-8、OPEN_QUESTIONS Q-017）。
 *
 * ## 保存前の値で試せる
 *
 * **完了条件。** 誤った鍵を保存してから気づく順序にしない。渡された値を
 * 解決済みの設定に重ねて試し、**保存はしない。**
 *
 * ## 副作用のない呼び出しだけを使う
 *
 * メールを実際に送ったり記事を生成したりしない。**確かめたいのは
 * 「鍵が通るか」**で、そのために課金や送信を起こす必要は無い。
 *
 * | 相手 | 使う呼び出し | 副作用 |
 * |---|---|---|
 * | Anthropic | `GET /v1/models` | 無し（トークンを消費しない） |
 * | Resend | `GET /domains` | 無し（メールを送らない） |
 *
 * ## 応答本文を画面へ出さない
 *
 * プロバイダーのエラー本文には課金情報や内部の識別子が混ざりうる（E-3）。
 * **こちらで用意した文言だけを返す。**
 *
 * ## `safeFetch` を通さない
 *
 * 宛先は**こちらが決めた固定のURL**で、利用者が入力した値ではない。
 * SSRF対策（C-7）が守る「利用者が宛先を決められるリクエスト」に当たらない。
 * 代わりにタイムアウトだけ自前で掛ける（E-3 と同じ）。
 */

import { resolveModel, type ModelTier } from '@/lib/ai';
import { getRuntimeEnv } from './resolve';
import { findSettingDefinition } from './catalog';
import { unknownSettingError } from './errors';

/** 何との接続を試すか */
export type ConnectionTarget = 'AI' | 'MAIL';

export const CONNECTION_TARGETS: readonly ConnectionTarget[] = ['AI', 'MAIL'];

export const CONNECTION_TARGET_LABELS: Readonly<
  Record<ConnectionTarget, string>
> = {
  AI: 'AI（Anthropic）',
  MAIL: 'メール送信（Resend）',
};

/** 失敗の種別。画面で出し分けるために持つ */
export const CONNECTION_TEST_CODES = {
  /** 鍵や送信元が設定されていない */
  notConfigured: 'CONNECTION_NOT_CONFIGURED',
  /** 鍵が受け付けられなかった */
  unauthorized: 'CONNECTION_UNAUTHORIZED',
  /** 設定した名前が相手側に無い（モデル名・ドメイン） */
  notFound: 'CONNECTION_NOT_FOUND',
  /** 呼び出しの上限に掛かった */
  rateLimited: 'CONNECTION_RATE_LIMITED',
  /** 相手側の障害 */
  providerError: 'CONNECTION_PROVIDER_ERROR',
  /** 時間内に応答が無い */
  timeout: 'CONNECTION_TIMEOUT',
  /** そもそも繋がらない */
  unreachable: 'CONNECTION_UNREACHABLE',
  /** 応答の形が想定と違う */
  invalidResponse: 'CONNECTION_INVALID_RESPONSE',
} as const;

export type ConnectionTestCode =
  (typeof CONNECTION_TEST_CODES)[keyof typeof CONNECTION_TEST_CODES];

export interface ConnectionTestResult {
  target: ConnectionTarget;
  ok: boolean;
  /** 画面に出す文言。**応答本文を含めない** */
  message: string;
  /** 失敗の種別。成功なら `null` */
  code: ConnectionTestCode | null;
  /** 参考情報。**秘密を入れない** */
  detail: Readonly<Record<string, string | number>>;
}

export interface ConnectionTestOptions {
  target: ConnectionTarget;
  /**
   * 保存前の値。解決済みの設定に重ねて使う。**保存はしない。**
   *
   * 一覧にない名前は受け付けない（`settings` 以外の環境変数を
   * 差し替えて外部を呼ばせないため）。
   */
  overrides?: Readonly<Record<string, string>> | undefined;
  /** 差し替え用 */
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  baseUrls?:
    | Readonly<{ anthropic?: string | undefined; resend?: string | undefined }>
    | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** 接続テストに許す時間。画面の操作なので短くする */
export const CONNECTION_TEST_TIMEOUT_MS = 15_000;

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_RESEND_BASE_URL = 'https://api.resend.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** 一覧に取り切れないほどモデルがある場合、モデル名の照合は諦める */
const MODEL_PAGE_SIZE = 100;

function fail(
  target: ConnectionTarget,
  code: ConnectionTestCode,
  message: string,
  detail: Record<string, string | number> = {},
): ConnectionTestResult {
  return { target, ok: false, code, message, detail };
}

function succeed(
  target: ConnectionTarget,
  message: string,
  detail: Record<string, string | number> = {},
): ConnectionTestResult {
  return { target, ok: true, code: null, message, detail };
}

/**
 * HTTPの状態番号を種別へ移す。
 *
 * **本文を読まない。** 課金情報や内部の識別子が混ざりうる（E-3）。
 */
function codeForStatus(status: number): ConnectionTestCode {
  if (status === 401 || status === 403) {
    return CONNECTION_TEST_CODES.unauthorized;
  }
  if (status === 429) {
    return CONNECTION_TEST_CODES.rateLimited;
  }

  return CONNECTION_TEST_CODES.providerError;
}

function messageForStatus(status: number, subject: string): string {
  if (status === 401 || status === 403) {
    return `${subject}が受け付けられませんでした。値を確認してください`;
  }
  if (status === 429) {
    return '呼び出しの上限に掛かりました。時間をおいて試してください';
  }
  if (status === 404) {
    return `接続先が見つかりませんでした（HTTP 404）。提供元の仕様が変わった可能性があります`;
  }

  return `接続先がエラーを返しました（HTTP ${status}）`;
}

interface Fetched {
  ok: true;
  response: Response;
}

interface Failed {
  ok: false;
  result: ConnectionTestResult;
}

async function request(
  target: ConnectionTarget,
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Fetched | Failed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return {
      ok: true,
      response: await fetchFn(url, { ...init, signal: controller.signal }),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ok: false,
        result: fail(
          target,
          CONNECTION_TEST_CODES.timeout,
          `${timeoutMs / 1000}秒以内に応答がありませんでした`,
        ),
      };
    }

    return {
      ok: false,
      result: fail(
        target,
        CONNECTION_TEST_CODES.unreachable,
        '接続先へ到達できませんでした',
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(value: Response): Promise<unknown | null> {
  try {
    return await value.json();
  } catch {
    return null;
  }
}

function readStringField(item: unknown, field: string): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }

  const value = (item as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : null;
}

function readArray(json: unknown, field: string): unknown[] | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }

  const value = (json as Record<string, unknown>)[field];

  return Array.isArray(value) ? value : null;
}

const TIERS: readonly ModelTier[] = ['LOW', 'STANDARD', 'HIGH'];

/**
 * Anthropic の鍵を確かめる。
 *
 * **設定したモデル名が実在するかまで見る。** 鍵が通ってもモデル名を
 * 打ち間違えていれば記事は生成できず、しかも**実際に生成するまで
 * 分からない**。ここで気づけるようにする。
 */
async function testAi(
  env: Readonly<Record<string, string | undefined>>,
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const apiKey = env['ANTHROPIC_API_KEY']?.trim() ?? '';

  if (apiKey === '') {
    return fail(
      'AI',
      CONNECTION_TEST_CODES.notConfigured,
      'ANTHROPIC_API_KEY が設定されていません',
    );
  }

  const baseUrl = options.baseUrls?.anthropic ?? DEFAULT_ANTHROPIC_BASE_URL;
  const fetched = await request(
    'AI',
    `${baseUrl}/v1/models?limit=${MODEL_PAGE_SIZE}`,
    {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    },
    options.fetchFn ?? fetch,
    options.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS,
  );

  if (!fetched.ok) {
    return fetched.result;
  }

  const { response } = fetched;

  if (!response.ok) {
    return fail(
      'AI',
      response.status === 404
        ? CONNECTION_TEST_CODES.providerError
        : codeForStatus(response.status),
      messageForStatus(response.status, 'APIキー'),
    );
  }

  const json = await readJson(response);
  const data = readArray(json, 'data');

  if (data === null) {
    return fail(
      'AI',
      CONNECTION_TEST_CODES.invalidResponse,
      '応答を読めませんでした',
    );
  }

  const available = new Set(
    data
      .map((item) => readStringField(item, 'id'))
      .filter((id): id is string => id !== null),
  );

  const detail: Record<string, string | number> = { モデル数: available.size };

  // **取り切れていないなら照合しない。** 全件見ていないのに
  // 「そのモデルは無い」と言うと、正しい設定を疑わせることになる
  const complete =
    typeof json === 'object' &&
    json !== null &&
    (json as Record<string, unknown>)['has_more'] !== true;

  if (complete) {
    const missing = TIERS.map((tier) => resolveModel(tier, { env }).model)
      .filter((model, index, all) => all.indexOf(model) === index)
      .filter((model) => !available.has(model));

    if (missing.length > 0) {
      return fail(
        'AI',
        CONNECTION_TEST_CODES.notFound,
        `鍵は通りましたが、設定したモデルが見つかりません：${missing.join('、')}`,
        detail,
      );
    }
  }

  return succeed('AI', '接続できました', detail);
}

/**
 * Resend の鍵を確かめる。
 *
 * **送信元ドメインが認証済みかまで見る。** 鍵が通っても未認証の
 * ドメインからは送れず、**管理者ログインのリンクが届かない**。
 * B-11 の残課題そのものなので、ここで見えるようにする。
 */
async function testMail(
  env: Readonly<Record<string, string | undefined>>,
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const apiKey = env['RESEND_API_KEY']?.trim() ?? '';
  const from = env['MAIL_FROM']?.trim() ?? '';
  const missing = [
    ...(apiKey === '' ? ['RESEND_API_KEY'] : []),
    ...(from === '' ? ['MAIL_FROM'] : []),
  ];

  if (missing.length > 0) {
    return fail(
      'MAIL',
      CONNECTION_TEST_CODES.notConfigured,
      `${missing.join('、')} が設定されていません`,
    );
  }

  const baseUrl = options.baseUrls?.resend ?? DEFAULT_RESEND_BASE_URL;
  const fetched = await request(
    'MAIL',
    `${baseUrl}/domains`,
    { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } },
    options.fetchFn ?? fetch,
    options.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS,
  );

  if (!fetched.ok) {
    return fetched.result;
  }

  const { response } = fetched;

  if (!response.ok) {
    return fail(
      'MAIL',
      codeForStatus(response.status),
      messageForStatus(response.status, 'APIキー'),
    );
  }

  const json = await readJson(response);
  const data = readArray(json, 'data');

  if (data === null) {
    return fail(
      'MAIL',
      CONNECTION_TEST_CODES.invalidResponse,
      '応答を読めませんでした',
    );
  }

  const domain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
  const verified = data.filter(
    (item) => readStringField(item, 'status') === 'verified',
  );
  const matched = verified.some(
    (item) => readStringField(item, 'name')?.toLowerCase() === domain,
  );

  const detail: Record<string, string | number> = {
    認証済みドメイン数: verified.length,
    送信元ドメイン: domain,
  };

  if (!matched) {
    return fail(
      'MAIL',
      CONNECTION_TEST_CODES.notFound,
      `鍵は通りましたが、${domain} が認証済みドメインにありません。このままでは送信できません`,
      detail,
    );
  }

  return succeed('MAIL', '接続できました', detail);
}

/**
 * 接続を試す。
 *
 * `overrides` を渡すと**保存前の値で試せる**（完了条件）。保存はしない。
 *
 * **例外を投げない。** 失敗も結果として返す — 接続が通らないのは
 * 画面が伝えるべき情報であって、処理の異常ではない。
 *
 * @throws {AppError} `overrides` に設定できない名前が混ざっている場合のみ
 */
export async function testConnectionForAdmin(
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const overrides = options.overrides ?? {};

  for (const key of Object.keys(overrides)) {
    // **一覧にない名前を重ねさせない。** 重ねられると、設定できない
    // 環境変数を差し替えて外部を呼ばせられる
    if (findSettingDefinition(key) === null) {
      throw unknownSettingError(key);
    }
  }

  const resolved = await getRuntimeEnv(options.env);
  const env: Record<string, string | undefined> = { ...resolved };

  for (const [key, value] of Object.entries(overrides)) {
    // 空文字は「入力していない」として扱う。伏せ字のまま送られたときに
    // 保存済みの値を上書きしないため
    if (value.trim() !== '') {
      env[key] = value.trim();
    }
  }

  return options.target === 'AI'
    ? testAi(env, options)
    : testMail(env, options);
}
