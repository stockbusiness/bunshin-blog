/**
 * 復号した秘密情報を包む型（TASKS C-1）。
 *
 * SPEC 14.2 は「ログへ秘密情報を出力しない」「クライアントへ秘密情報を
 * 返さない」と定める。A-4 のロガーはフィールド名でマスクするが、
 * **名前が変わればすり抜ける**。`JSON.stringify` や文字列連結も同じ。
 *
 * そこで復号値は生の `string` として持ち回らず、この `Secret` に包む。
 * 中身は private フィールドに持つため、次のいずれでも外へ出ない。
 *
 * - `JSON.stringify(...)`（`toJSON` が `[REDACTED]` を返す）
 * - `` `${secret}` `` や `'' + secret`（`toString`）
 * - `console.log(secret)` / `util.inspect(...)`（inspect カスタム）
 *
 * 値を使うときだけ `expose()` を呼ぶ。**呼び出し箇所を grep できる**ことが
 * この型の主な価値であり、`expose()` の結果を変数に置いて持ち回らない。
 */

import { REDACTED } from '@/lib/logger';

/** Node の `util.inspect` が参照するシンボル。`node:util` を import せずに使う */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * 中身を取り出す。**外へ出す直前でだけ呼ぶ。**
   *
   * WordPress への Basic 認証ヘッダーの組み立てなど、実際に使う場所に限る。
   */
  expose(): string {
    return this.#value;
  }

  /** 値が空かどうか。中身を出さずに「未設定」を判定するため */
  get isEmpty(): boolean {
    return this.#value === '';
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }

  [INSPECT_CUSTOM](): string {
    return REDACTED;
  }
}

/** 空の `Secret`。認証情報が保存されていない状態を表す */
export const EMPTY_SECRET = new Secret('');
