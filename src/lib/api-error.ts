/**
 * APIが返した失敗の理由を、画面へ出せる形で取り出す。
 *
 * ## なぜ共通にするのか
 *
 * **サーバーが返す形は1つだけ**（`toErrorHttpResponse`）。
 *
 * ```json
 * { "error": { "code": "...", "message": "..." } }
 * ```
 *
 * ところが**画面側で `body.message` と読んでいた場所が6つあった。**
 * その形は存在しないので `undefined` になり、
 * **サーバーが理由を説明しているのに、画面には決まり文句しか出ない。**
 *
 * 実際、`/admin/rich-menu` が「うまくいきませんでした」しか出さず、
 * **何が起きているのか画面からは分からなかった**（2026-08-17）。
 *
 * **読み方を1か所に集める。** 各画面が自前で解くと、また片方だけずれる。
 *
 * ## ブラウザで動く
 *
 * 文字列を取り出すだけで、サーバー専用のものに触れない
 * （MODULE_RULES 4）。
 */

/**
 * `{ error: { message } }` から文言を取り出す。
 *
 * **取り出せなければ `fallback`。** 空文字も取り出せなかった扱いにする —
 * 空の吹き出しが出ると、何も起きていないように見える。
 */
export function readApiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) {
    return fallback;
  }

  const error = (body as Record<string, unknown>)['error'];

  if (typeof error !== 'object' || error === null) {
    return fallback;
  }

  const message = (error as Record<string, unknown>)['message'];

  return typeof message === 'string' && message !== '' ? message : fallback;
}
