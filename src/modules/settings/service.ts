/**
 * 管理画面から使う入口（TASKS H-7、OPEN_QUESTIONS Q-017）。
 *
 * **設定は利用者に紐づかない。** システム全体で1組で、触れるのは ADMIN だけ。
 * 所有権の判定に使える情報が無いので `...ForUser` の形にならない。
 * 横断参照であることが分かる名前にする（MODULE_RULES 5、E-2 と同じ扱い）。
 * **呼び出し側で `requireAdmin` を通すこと。**
 *
 * ここから**平文の秘密は出ない**。出るのは伏せ字と更新日時だけ（Q-017）。
 */

import {
  SETTING_DEFINITIONS,
  findSettingDefinition,
  type SettingDefinition,
} from './catalog';
import {
  invalidSettingValueError,
  settingNotFoundError,
  unknownSettingError,
} from './errors';
import { maskSecret } from './mask';
import { deleteSettingRow, upsertSettingRow } from './repository';
import { readStoredSettings, sourceOf, type StoredSetting } from './resolve';
import type { SettingView } from './types';

function definitionOrThrow(key: string): SettingDefinition {
  const definition = findSettingDefinition(key);

  if (definition === null) {
    throw unknownSettingError(key);
  }

  return definition;
}

/**
 * 入力値を検証して整える。
 *
 * **失敗しても入力値をメッセージへ入れない。** 秘密の設定も同じ経路を
 * 通るため、入れるとAPIキーがエラーとして出ていく。
 */
export function normalizeSettingValue(key: string, value: unknown): string {
  const definition = definitionOrThrow(key);
  const result = definition.schema.safeParse(value);

  if (!result.success) {
    const reason =
      result.error.issues[0]?.message ?? '入力の形式が正しくありません';

    throw invalidSettingValueError(key, reason);
  }

  return result.data;
}

function toView(
  definition: SettingDefinition,
  stored: StoredSetting | undefined,
  envValue: string | undefined,
): SettingView {
  const source = sourceOf(stored, envValue);

  const raw =
    source === 'DB'
      ? (stored?.value ?? null)
      : source === 'ENV'
        ? (envValue ?? null)
        : null;

  return {
    key: definition.key,
    group: definition.group,
    label: definition.label,
    description: definition.description,
    secret: definition.secret,
    source,
    display: raw === null ? null : definition.secret ? maskSecret(raw) : raw,
    updatedAt: source === 'DB' ? (stored?.updatedAt ?? null) : null,
    updatedByUserId: source === 'DB' ? (stored?.updatedByUserId ?? null) : null,
  };
}

/**
 * 設定できる項目をすべて返す（未設定のものも含む）。
 *
 * **未設定の項目も出す。** 設定済みのものだけを並べると、「何を設定できるか」
 * が画面から分からない。
 *
 * `source` を必ず返すのは、**環境変数の値が効いている状態を見えるように
 * するため**。これが分からないと「画面で設定したのに効かない」の逆
 * （画面には出ていないのに動いている）が説明できない。
 */
export async function listSettingsForAdmin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SettingView[]> {
  const stored = await readStoredSettings();

  return SETTING_DEFINITIONS.map((definition) =>
    toView(definition, stored.get(definition.key), env[definition.key]),
  );
}

/**
 * 値を保存する。
 *
 * 秘密は暗号化して `value_encrypted` へ入る（列の取り違えはDBの CHECK でも
 * 拒まれる）。**保存後に読み返す入口は無い。**
 *
 * @throws {AppError} 設定できる名前でない・値の形式が違う
 */
export async function saveSettingForAdmin(params: {
  key: string;
  value: unknown;
  actorUserId: string | null;
}): Promise<SettingView> {
  const definition = definitionOrThrow(params.key);
  const value = normalizeSettingValue(params.key, params.value);

  const row = await upsertSettingRow({
    key: definition.key,
    value,
    secret: definition.secret,
    actorUserId: params.actorUserId,
  });

  return toView(
    definition,
    {
      value,
      unreadable: false,
      updatedAt: row.updatedAt,
      updatedByUserId: row.updatedByUserId,
    },
    undefined,
  );
}

/**
 * 設定を解除する。
 *
 * **行ごと消す**（H-7-schema）。解決順が環境変数・コード既定へ落ちる。
 *
 * @throws {AppError} 設定できる名前でない・そもそも設定されていない
 */
export async function clearSettingForAdmin(params: {
  key: string;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}): Promise<SettingView> {
  const definition = definitionOrThrow(params.key);
  const deleted = await deleteSettingRow(definition.key);

  if (!deleted) {
    throw settingNotFoundError(definition.key);
  }

  const env = params.env ?? process.env;

  return toView(definition, undefined, env[definition.key]);
}
