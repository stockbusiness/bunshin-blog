/**
 * AES-256-GCM による保存データの暗号化（TASKS C-1、SPEC 5.4・14.2）。
 *
 * 対象は DATA_MODEL 7章の3列。
 * - `wordpress_connections.wp_username_encrypted`
 * - `wordpress_connections.app_password_encrypted`
 * - `search_console_connections.refresh_token_encrypted`（G-1）
 *
 * WordPress 固有の処理ではないため `src/lib/` に置く。
 * **鍵はここでは読まない。** 呼び出し側が渡す（テストから任意の鍵を使えるように）。
 * 環境変数から読むのは `key.ts`。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret } from './secret';

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/** AES-256 の鍵長 */
export const ENCRYPTION_KEY_BYTES = 32;

/** GCM の推奨 IV 長。96bit 以外は内部で再ハッシュされ、衝突耐性が落ちる */
export const ENCRYPTION_IV_BYTES = 12;

/** GCM の認証タグ長 */
export const ENCRYPTION_TAG_BYTES = 16;

/**
 * 保存形式のバージョン。
 *
 * 鍵の更新やアルゴリズムの変更を後から入れられるように先頭へ付ける。
 * 付けずに保存すると、移行時に「どの方式で入っている行か」が判別できない。
 */
export const ENCRYPTION_VERSION = 'v1';

const FIELD_SEPARATOR = '.';
const FIELD_COUNT = 4;

/**
 * 復号に失敗したことを表す。
 *
 * **失敗の理由を分けない。** 「鍵が違う」「改竄されている」「形式が壊れている」
 * を区別して返すと、暗号文をいじりながら反応を見る攻撃の手がかりになる。
 * 暗号文・鍵・平文をメッセージへ含めない。
 */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';

  constructor(options: { cause?: unknown } = {}) {
    super('暗号化された値を復号できませんでした', options);
  }
}

/** 鍵の長さが不正なことを表す。値そのものはメッセージへ含めない */
export class EncryptionKeyError extends Error {
  override readonly name = 'EncryptionKeyError';

  constructor(message: string) {
    super(message);
  }
}

export interface CryptoOptions {
  /** 32バイトの鍵 */
  key: Buffer;
  /**
   * 追加認証データ。暗号文を「その行のその列」に結び付ける。
   *
   * これが無いと、DBへ書ける立場の攻撃者が他人の行の暗号文を
   * 自分の行へ複製できてしまう（暗号文としては正しく復号される）。
   * `wordpress_connection:<blogId>:app_password` のように、
   * 移動されると困る単位で指定する。
   */
  aad?: string | undefined;
}

function assertKey(key: Buffer): void {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError(
      `暗号化キーは${ENCRYPTION_KEY_BYTES}バイトである必要があります`,
    );
  }
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

/**
 * 平文を暗号化し、保存用の文字列を返す。
 *
 * 形式は `v1.<iv>.<tag>.<ciphertext>`（それぞれ base64url）。
 * IV は毎回新しく生成する。**同じ鍵で IV を再利用すると GCM は平文が復元できる**
 * ため、IV を外から渡せるようにはしていない。
 */
export function encryptSecret(
  plaintext: string,
  options: CryptoOptions,
): string {
  assertKey(options.key);

  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, options.key, iv, {
    authTagLength: ENCRYPTION_TAG_BYTES,
  });

  if (options.aad !== undefined) {
    cipher.setAAD(Buffer.from(options.aad, 'utf8'));
  }

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    ENCRYPTION_VERSION,
    toBase64Url(iv),
    toBase64Url(cipher.getAuthTag()),
    toBase64Url(ciphertext),
  ].join(FIELD_SEPARATOR);
}

/** base64url として妥当な文字だけで構成されているか */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function fromBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) {
    throw new DecryptionError();
  }

  const decoded = Buffer.from(value, 'base64url');

  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new DecryptionError();
  }

  return decoded;
}

/**
 * 保存用の文字列を復号する。
 *
 * 戻り値は `Secret`。生の文字列を返すと、そのままログやレスポンスへ
 * 流れる経路ができてしまう（SPEC 14.2）。
 *
 * @throws {DecryptionError} 形式・鍵・AAD・認証タグのいずれかが合わない場合
 */
export function decryptSecret(payload: string, options: CryptoOptions): Secret {
  assertKey(options.key);

  const fields = payload.split(FIELD_SEPARATOR);
  if (fields.length !== FIELD_COUNT) {
    throw new DecryptionError();
  }

  const [version, ivField, tagField, ciphertextField] = fields as [
    string,
    string,
    string,
    string,
  ];

  if (version !== ENCRYPTION_VERSION) {
    throw new DecryptionError();
  }

  const iv = fromBase64Url(ivField, ENCRYPTION_IV_BYTES);
  const tag = fromBase64Url(tagField, ENCRYPTION_TAG_BYTES);
  const ciphertext = fromBase64Url(ciphertextField);

  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, options.key, iv, {
      authTagLength: ENCRYPTION_TAG_BYTES,
    });

    if (options.aad !== undefined) {
      decipher.setAAD(Buffer.from(options.aad, 'utf8'));
    }

    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      // 認証タグが合わなければここで例外になる
      decipher.final(),
    ]);

    return new Secret(plaintext.toString('utf8'));
  } catch (error) {
    throw new DecryptionError({ cause: error });
  }
}

/** 暗号化された文字列の形式として妥当か。復号はしない */
export function isEncryptedPayload(value: string): boolean {
  const fields = value.split(FIELD_SEPARATOR);

  return (
    fields.length === FIELD_COUNT &&
    fields[0] === ENCRYPTION_VERSION &&
    fields.slice(1).every((field) => BASE64URL.test(field))
  );
}

/**
 * 空文字を暗号化したものかどうかを、**鍵を使わずに**判定する。
 *
 * GCM は平文と同じ長さの暗号文を出すため、暗号文が空なら平文も空。
 * 「認証情報が保存されていない」を、復号せずに言えるようにする。
 * 形式が壊れている場合も「中身が無い」として扱う。
 */
export function isEmptyPayload(value: string): boolean {
  if (!isEncryptedPayload(value)) {
    return true;
  }

  return value.split(FIELD_SEPARATOR)[3] === '';
}
