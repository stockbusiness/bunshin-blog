/**
 * settings モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `app_settings` を触ってよいのはこのモジュールだけ。
 *
 * **設定は利用者に紐づかない。** 触れるのは ADMIN で、入口は `...ForAdmin`。
 * 呼び出し側で `requireAdmin` を通すこと。
 *
 * **サーバー専用。** `getRuntimeEnv` は秘密の平文を含む辞書を返すため、
 * ブラウザ向けのコードから import しない（MODULE_RULES 4）。
 */

export {
  listSettingsForAdmin,
  saveSettingForAdmin,
  clearSettingForAdmin,
  normalizeSettingValue,
} from './service';

export { getRuntimeEnv } from './resolve';

export { createConfiguredAiProvider } from './provider';

export {
  testConnectionForAdmin,
  CONNECTION_TARGETS,
  CONNECTION_TARGET_LABELS,
  CONNECTION_TEST_CODES,
  CONNECTION_TEST_TIMEOUT_MS,
  type ConnectionTarget,
  type ConnectionTestCode,
  type ConnectionTestResult,
  type ConnectionTestOptions,
} from './connection-test';

export {
  SETTING_DEFINITIONS,
  SETTING_GROUP_LABELS,
  findSettingDefinition,
  isSettingKey,
  isSecretSetting,
  settingKeys,
  type SettingDefinition,
  type SettingGroup,
} from './catalog';

export {
  maskSecret,
  MASK_CHARACTER,
  MASK_LENGTH,
  MASK_VISIBLE_TAIL,
} from './mask';

export {
  SETTING_ERROR_CODES,
  unknownSettingError,
  invalidSettingValueError,
  settingNotFoundError,
  type SettingErrorCode,
} from './errors';

export type { SettingView, SettingSource } from './types';
