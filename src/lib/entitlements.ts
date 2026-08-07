/**
 * 権限判定の入口（TASKS A-4）。
 *
 * 将来のオプション課金に備え、判定を1箇所に集約する。
 * **Phase 0 では課金を実装しないため、常に `true` を返す。**
 *
 * 将来ここだけを差し替えれば課金判定が有効になる、という前提で書いている。
 * そのため:
 * - 呼び出し側は必ず `can()` を経由し、プランやフラグを直接見ない
 * - 非同期にしてあるのは、将来DBやプラン情報を参照するため。同期実装に
 *   変えると全呼び出し箇所の書き換えが必要になる
 *
 * 課金テーブル・プラン設計・決済連携は Phase 0 では作らない。
 */

/**
 * 課金や権限で制御しうる操作。
 *
 * 新しい capability は「それを必要とするモジュールのタスク」で追加する。
 * ここに先回りして並べない。
 */
export const CAPABILITIES = [
  'blog.create',
  'article.generate',
  'video.generate',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * ユーザーが操作を行えるかを判定する。
 *
 * Phase 0 は課金が無いため常に `true`。将来、プラン・利用量・停止状態を
 * ここで判定する。
 *
 * @param userId 判定対象のユーザーID
 * @param capability 判定対象の操作
 */
export async function can(
  userId: string,
  capability: Capability,
): Promise<boolean> {
  // Phase 0: 課金未実装。引数は将来の実装で使うため受け取るだけにする
  void userId;
  void capability;

  return true;
}
