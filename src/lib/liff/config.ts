/**
 * LIFF の設定値（B-8）。
 *
 * **このファイルはブラウザで動く。** サーバー専用のモジュール
 * （`@/lib/env` `@/lib/db`）を import してはならない。
 *
 * `NEXT_PUBLIC_LIFF_ID` はビルド時にバンドルへ埋め込まれる。そのため
 * `getServerEnv()` の起動時検証には含めない。**起動時に見ても、既に
 * 焼き付いた値を確認するだけで、実際の失敗を防げない**ためである。
 * 未設定はブラウザ側で検出し、画面に出す。
 */

/** LIFF ID の形式。`<数字>-<英数字>`（例 `1234567890-abcdefgh`） */
const LIFF_ID_PATTERN = /^\d+-[0-9A-Za-z]+$/;

export const LIFF_ID_ENV_NAME = 'NEXT_PUBLIC_LIFF_ID';

export type LiffConfigResult =
  { ok: true; liffId: string } | { ok: false; message: string };

/**
 * LIFF ID を取り出す。
 *
 * 例外を投げずに結果を返す。設定漏れは運用上ありうる状態であり、
 * 画面に理由を出したいため。**値そのものはメッセージに含めない**
 * （SPEC 14.2 の方針に合わせる。LIFF ID は秘密ではないが、
 * 設定値をそのまま画面へ出す癖をつけない）。
 */
export function readLiffConfig(
  source: Record<string, string | undefined>,
): LiffConfigResult {
  const value = source[LIFF_ID_ENV_NAME];

  if (value === undefined || value.trim() === '') {
    return {
      ok: false,
      message: `${LIFF_ID_ENV_NAME} が設定されていません`,
    };
  }

  const liffId = value.trim();

  if (!LIFF_ID_PATTERN.test(liffId)) {
    return {
      ok: false,
      message: `${LIFF_ID_ENV_NAME} の形式が正しくありません`,
    };
  }

  return { ok: true, liffId };
}
