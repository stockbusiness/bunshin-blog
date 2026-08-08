/**
 * リダイレクタのリンク（`affiliate_links`）の発行（TASKS D-8、Q-001）。
 *
 * `REDIRECT` の案件では、記事本文に `/go/<code>` を埋める。その `code` と
 * 飛び先をここで作る。
 *
 * **`DIRECT` の案件では発行しない。** 直リンクのまま出す（Q-001）ので、
 * リンクの行を作る意味が無い。
 *
 * DBを触らない純粋な処理。保存は `repository.ts` の担当。
 */

import { randomBytes } from 'node:crypto';

/**
 * コードの長さ（文字数）。
 *
 * **総当たりで他人のリンクを引き当てられない長さにする。** 記事に埋まる
 * 値なので短いほうが見栄えはよいが、`/go/<code>` は**認証が無い入口**で、
 * 当たれば飛び先（アフィリエイトURL）が分かる。
 *
 * 22文字の base64url は約128ビット。
 */
export const REDIRECT_CODE_LENGTH = 22;

/** base64url の文字だけを許す（URLで意味を持つ文字を含めない） */
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * リダイレクタのコードを作る。
 *
 * **推測できない値にする。** 連番や `content_item_id` から作ると、
 * 1つ知られただけで他も引ける。
 */
export function generateRedirectCode(): string {
  // base64url は3バイトごとに4文字。必要な長さより多めに作って切る
  return randomBytes(24).toString('base64url').slice(0, REDIRECT_CODE_LENGTH);
}

/** 受け取ったコードが形として通るか（DBを引く前に弾く） */
export function isRedirectCode(value: string): boolean {
  return value.length === REDIRECT_CODE_LENGTH && CODE_PATTERN.test(value);
}
