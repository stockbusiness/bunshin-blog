/**
 * 秘密の設定を画面へ出すための伏せ字（TASKS H-7、Q-017）。
 *
 * **保存済みの秘密を復号して返す入口を作らない。** 出すのは末尾4文字と
 * 更新日時だけ。「表示」ボタンも作らない — 一度入れた鍵を読み返す必要は
 * 運用上無く、経路があるだけで漏洩面が増える。
 *
 * 末尾4文字を残すのは、**どの鍵が入っているかを見分けるため**。
 * 発行元の画面に出ている値の末尾と突き合わせられれば、
 * 「差し替えたつもりが古い鍵のままだった」に気づける。
 *
 * DBを触らない純粋な処理。
 */

/** 伏せ字に使う文字 */
export const MASK_CHARACTER = '•';

/** 伏せ字の長さ。実際の長さを伝えない（短い鍵だと総当たりの手がかりになる） */
export const MASK_LENGTH = 8;

/** 末尾を見せる文字数 */
export const MASK_VISIBLE_TAIL = 4;

/**
 * 秘密を伏せる。
 *
 * **短い値は末尾を見せない。** 8文字の値の末尾4文字を出すと、
 * 半分が分かってしまう。
 */
export function maskSecret(value: string): string {
  const filled = MASK_CHARACTER.repeat(MASK_LENGTH);

  if (value.length < MASK_VISIBLE_TAIL * 3) {
    return filled;
  }

  return `${filled}${value.slice(-MASK_VISIBLE_TAIL)}`;
}
