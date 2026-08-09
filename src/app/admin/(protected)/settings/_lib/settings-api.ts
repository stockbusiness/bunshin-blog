/**
 * `/admin/settings` からのAPI呼び出し（TASKS H-9）。
 *
 * **ブラウザで動く。** `@/modules/settings` を import しない
 * （サーバー専用で、秘密の平文を扱う。MODULE_RULES 4）。型だけを写す。
 */

export type SettingSource = 'DB' | 'ENV' | 'UNSET' | 'UNREADABLE';

export interface SettingJson {
  key: string;
  group: string;
  label: string;
  description: string;
  secret: boolean;
  /** 選べる値。決まっていなければ `null`（自由入力） */
  choices: string[] | null;
  source: SettingSource;
  display: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export interface ConnectionTestJson {
  target: string;
  ok: boolean;
  message: string;
  code: string | null;
  detail: Record<string, string | number>;
}

/** APIが返した想定内のエラー。文言をそのまま画面へ出す */
export class SettingsApiError extends Error {
  override readonly name = 'SettingsApiError';
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

async function readError(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const error =
    typeof body === 'object' && body !== null
      ? (body as { error?: { message?: unknown; code?: unknown } }).error
      : undefined;

  throw new SettingsApiError(
    typeof error?.message === 'string' ? error.message : '処理できませんでした',
    typeof error?.code === 'string' ? error.code : 'INTERNAL',
  );
}

export async function saveSetting(
  key: string,
  value: string,
): Promise<SettingJson> {
  const response = await fetch(
    `/api/admin/settings/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
  );

  if (!response.ok) {
    return readError(response);
  }

  return ((await response.json()) as { setting: SettingJson }).setting;
}

export async function clearSetting(key: string): Promise<SettingJson> {
  const response = await fetch(
    `/api/admin/settings/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );

  if (!response.ok) {
    return readError(response);
  }

  return ((await response.json()) as { setting: SettingJson }).setting;
}

/**
 * 接続を試す。
 *
 * **入力途中の値を渡す。** 保存してから試す順序にしない（H-8）。
 */
export async function testConnection(
  target: string,
  overrides: Record<string, string>,
): Promise<ConnectionTestJson> {
  const response = await fetch('/api/admin/settings/connection-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, overrides }),
  });

  if (!response.ok) {
    return readError(response);
  }

  return ((await response.json()) as { result: ConnectionTestJson }).result;
}
