/**
 * 暗号化キーの形式検証（TASKS C-1）。
 *
 * `src/lib/env.ts` の起動時検証から呼ぶため、**環境変数を読むコードを
 * ここへ入れない。** 入れると `env.ts` との循環 import になる。
 * 環境変数から実際に鍵を取り出すのは `key.ts`。
 */

import { ENCRYPTION_KEY_BYTES, EncryptionKeyError } from './aes-gcm';

/**
 * base64 の文字列を32バイトの鍵として解釈する。
 *
 * `Buffer.from(value, 'base64')` は不正な文字を黙って捨てるため、
 * **再エンコードして一致を確かめる**。捨てられたまま通すと、打ち間違えた
 * 鍵で暗号化して、あとから復号できなくなる。
 *
 * @throws {EncryptionKeyError} 形式または長さが不正な場合。値は含めない
 */
export function decodeEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, 'base64');

  if (decoded.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY は base64 で${ENCRYPTION_KEY_BYTES}バイトである必要があります`,
    );
  }

  // パディングの有無だけの差は許容し、文字の取りこぼしのみを弾く
  const normalized = trimmed.replace(/=+$/, '');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY が base64 として解釈できません',
    );
  }

  return decoded;
}

/** 起動時検証（`src/lib/env.ts`）から使う。例外を投げずに判定する */
export function isValidEncryptionKey(value: string): boolean {
  try {
    decodeEncryptionKey(value);
    return true;
  } catch {
    return false;
  }
}
