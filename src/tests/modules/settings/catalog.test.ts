import { describe, expect, it } from 'vitest';
import {
  SETTING_DEFINITIONS,
  findSettingDefinition,
  isSecretSetting,
  isSettingKey,
  settingKeys,
} from '@/modules/settings';

/**
 * 設定できる項目の一覧（TASKS H-7、Q-017）。
 *
 * ここが唯一の正で、**ここに無い名前は保存できない。**
 */

describe('設定できる名前', () => {
  it('一覧にある名前だけを受け付ける', () => {
    expect(isSettingKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(findSettingDefinition('ANTHROPIC_API_KEY')?.secret).toBe(true);
  });

  /**
   * **これが完了条件の一部。** 任意の名前を受け取れるようにすると、
   * 管理画面が「環境変数を何でも書き換えられる入口」になる。
   */
  it.each([
    ['DATABASE_URL', '設定そのものを読むのに要る'],
    ['ENCRYPTION_KEY', '保存された秘密を復号する鍵'],
    ['SESSION_SECRET', '管理画面へ入る認証に要る'],
    ['APP_BASE_URL', 'ログインリンクの組み立て。画面へ入る前に要る'],
    ['CRON_SECRET', 'アプリの外から使う'],
    ['NEXT_PUBLIC_LIFF_ID', 'ビルド時に埋め込まれる'],
    ['NODE_ENV', ''],
    ['PATH', ''],
  ])('%s は設定できない', (key) => {
    expect(isSettingKey(key)).toBe(false);
    expect(findSettingDefinition(key)).toBeNull();
  });

  /** 名前の重複があると、あとから足した定義が黙って効かなくなる */
  it('名前が重複していない', () => {
    const keys = settingKeys();

    expect(new Set(keys).size).toBe(keys.length);
  });

  /** DBの CHECK 制約（`app_settings_key_format`）に合う形にする */
  it('名前は環境変数と同じ綴り', () => {
    for (const key of settingKeys()) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('APIキーは秘密として扱う', () => {
    expect(isSecretSetting('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretSetting('RESEND_API_KEY')).toBe(true);
  });

  /** 伏せてしまうと、いま何が効いているのか画面から読めなくなる */
  it('モデル名や単価は秘密にしない', () => {
    expect(isSecretSetting('AI_MODEL_STANDARD')).toBe(false);
    expect(isSecretSetting('AI_PRICE_STANDARD_INPUT')).toBe(false);
    expect(isSecretSetting('MAIL_FROM')).toBe(false);
  });

  /**
   * **読む処理が無い設定を出さない**（A-3 の方針）。
   * `LINE_CHANNEL_ACCESS_TOKEN` は F-2、`LINE_CHANNEL_SECRET` は D-7b
   * （webhook の署名検証）で読み手ができたので足した。
   */
  it('まだ誰も読まない設定を並べていない', () => {
    expect(isSettingKey('WORDPRESS_APP_PASSWORD')).toBe(false);
  });

  /**
   * **チャネルIDはここにある**（Q-046）。起動には要らず、LIFF の
   * 利用者がログインするときに初めて要る。LIFF のエンドポイントには
   * アプリの公開URLが要るので、**LINE の設定はアプリを立てた後**にしかできない。
   */
  it('LINEログインのチャネルIDが並んでいる', () => {
    expect(isSettingKey('LINE_LOGIN_CHANNEL_ID')).toBe(true);
    // **ブラウザにも配られる値。** 伏せると取り違えたときに見比べられない
    expect(isSecretSetting('LINE_LOGIN_CHANNEL_ID')).toBe(false);
  });

  /** 通知に使うトークンは伏せる。飛び先のURLは伏せない（F-2・D-7b） */
  it('LINE の設定が並んでいる', () => {
    expect(isSecretSetting('LINE_CHANNEL_ACCESS_TOKEN')).toBe(true);
    // **署名の鍵は伏せる。** 漏れると、なりすました返信で
    // 分身の記憶を外から書き込める
    expect(isSecretSetting('LINE_CHANNEL_SECRET')).toBe(true);
    expect(isSecretSetting('LIFF_BASE_URL')).toBe(false);
  });

  it('すべての項目に説明がある', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });
});
