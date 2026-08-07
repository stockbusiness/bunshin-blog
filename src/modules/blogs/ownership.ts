import { AppError } from '@/lib/errors';

/**
 * 所有権検証の共通ヘルパー（B-3）。
 *
 * TASKS.md：「所有権検証は B-3 で共通ヘルパーとして実装し、以降の全モジュールで
 * 使い回す。各所で `WHERE id = :id AND user_id = :sessionUserId` を書かせない」
 *
 * SPEC 14.1 が禁止しているのは次の3つ。
 * - IDだけで blog を取得する
 * - IDだけで approval を取得する
 * - クライアント指定の `user_id` を信用する
 */

/**
 * 所有権に関するエラーコード。
 *
 * slot の上限・重複は `slots.ts` の `BLOG_SLOT_ERROR_CODES`（B-4）。
 */
export const BLOG_ERROR_CODES = {
  /** 存在しない、または自分のものではない */
  notFound: 'BLOG_NOT_FOUND',
} as const;

/**
 * 所有していない資源へのアクセスは **404 を返す**。
 *
 * 403 だと「そのIDは存在するが他人のものだ」と伝えることになり、
 * IDの総当たりで他ユーザーの資源の有無を調べられる。
 * 存在しない場合と区別しない。
 */
export function notFoundError(resource = 'ブログ'): AppError {
  return new AppError(
    BLOG_ERROR_CODES.notFound,
    404,
    `${resource}が見つかりません`,
  );
}

/**
 * 所有権で絞り込む `where` 条件を作る。
 *
 * **各モジュールはこれを使い、`where` を手で組み立てない。**
 * 引数の順序を間違えても型で気づけるよう、オブジェクトで受ける。
 */
export function ownedBy(params: { userId: string; id: string }): {
  id: string;
  userId: string;
} {
  if (params.userId === '' || params.id === '') {
    // セッションが解決できていない状態で呼ばれると、
    // 空文字が条件に入って意図しない行に当たりうる
    throw new Error('所有権の条件に空のIDが渡されました');
  }

  return { id: params.id, userId: params.userId };
}

/**
 * 取得結果が null なら 404 にする。
 *
 * 所有権付きで引いた結果に対して使うことで、「他人のもの」と
 * 「存在しない」を同じ応答に揃える。
 */
export function requireFound<T>(value: T | null, resource?: string): T {
  if (value === null) {
    throw notFoundError(resource);
  }

  return value;
}
