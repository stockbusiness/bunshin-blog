/**
 * 環境変数からの暗号化キーの取り出し（TASKS C-1）。
 *
 * `ENCRYPTION_KEY` は base64 の32バイト。生成は次のとおり。
 *
 * ```sh
 * openssl rand -base64 32
 * ```
 *
 * **鍵を失うと保存済みの認証情報は復号できない。** 環境ごとに別の値を使い、
 * 本番の値をリポジトリへ入れない（SPEC 14.2）。
 */

import { getServerEnv } from '@/lib/env';
import { decodeEncryptionKey } from './key-format';

let cached: Buffer | undefined;

/**
 * 環境変数から暗号化キーを取り出す。初回に復号し、以降はキャッシュを返す。
 *
 * **モジュール読み込み時ではなく呼び出し時に読む。** 読み込み時にすると、
 * 環境変数が要らないビルドやテストまで巻き込んで失敗する。
 */
export function getEncryptionKey(): Buffer {
  cached ??= decodeEncryptionKey(getServerEnv().ENCRYPTION_KEY);
  return cached;
}

/** テスト用。キャッシュを破棄する */
export function resetEncryptionKeyCache(): void {
  cached = undefined;
}
