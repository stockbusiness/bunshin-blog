/**
 * 暗号化ユーティリティの公開インターフェース（TASKS C-1）。
 *
 * **サーバー専用。** `node:crypto` を使うため、ブラウザ向けのコードから
 * import しない（MODULE_RULES 4）。
 */

export {
  encryptSecret,
  decryptSecret,
  isEncryptedPayload,
  isEmptyPayload,
  DecryptionError,
  EncryptionKeyError,
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_VERSION,
  ENCRYPTION_KEY_BYTES,
  ENCRYPTION_IV_BYTES,
  ENCRYPTION_TAG_BYTES,
  type CryptoOptions,
} from './aes-gcm';

export { Secret, EMPTY_SECRET } from './secret';

export { decodeEncryptionKey, isValidEncryptionKey } from './key-format';

export { getEncryptionKey, resetEncryptionKeyCache } from './key';
