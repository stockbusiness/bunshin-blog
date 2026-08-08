import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecryptionError,
  ENCRYPTION_IV_BYTES,
  ENCRYPTION_KEY_BYTES,
  ENCRYPTION_TAG_BYTES,
  ENCRYPTION_VERSION,
  EncryptionKeyError,
  Secret,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  isEmptyPayload,
  isEncryptedPayload,
  getEncryptionKey,
  isValidEncryptionKey,
  resetEncryptionKeyCache,
} from '@/lib/crypto';
import { resetServerEnvCache } from '@/lib/env';
import { createLogger, type LogEntry } from '@/lib/logger';

/**
 * 暗号化ユーティリティのテスト（TASKS C-1）。
 *
 * 確かめるのは次の3つ。
 * - 往復できること
 * - **改竄・鍵違い・AAD違いを検出すること**（GCM を使う理由そのもの）
 * - **復号値が意図せず外へ出ないこと**（SPEC 14.2）
 */

const KEY = randomBytes(ENCRYPTION_KEY_BYTES);
const OTHER_KEY = randomBytes(ENCRYPTION_KEY_BYTES);

/** `getServerEnv()` は全ての必須変数を見る。鍵以外はダミーで埋める */
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/bunshin',
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  SESSION_SECRET: 'x'.repeat(48),
  ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
};

describe('encryptSecret / decryptSecret', () => {
  it('暗号化した値を復号できる', () => {
    const payload = encryptSecret('app-password-1234', { key: KEY });

    expect(decryptSecret(payload, { key: KEY }).expose()).toBe(
      'app-password-1234',
    );
  });

  it('日本語や記号を含む値も往復できる', () => {
    const plaintext = 'パスワード🔐 with spaces & symbols/+=';
    const payload = encryptSecret(plaintext, { key: KEY });

    expect(decryptSecret(payload, { key: KEY }).expose()).toBe(plaintext);
  });

  it('空文字も往復できる', () => {
    const payload = encryptSecret('', { key: KEY });

    expect(decryptSecret(payload, { key: KEY }).expose()).toBe('');
  });

  it('平文が暗号文に現れない', () => {
    const payload = encryptSecret('super-secret-value', { key: KEY });

    expect(payload).not.toContain('super-secret-value');
  });

  it('同じ平文でも毎回異なる暗号文になる（IVを使い回さない）', () => {
    const first = encryptSecret('same', { key: KEY });
    const second = encryptSecret('same', { key: KEY });

    expect(first).not.toBe(second);
    expect(decryptSecret(first, { key: KEY }).expose()).toBe('same');
    expect(decryptSecret(second, { key: KEY }).expose()).toBe('same');
  });

  it('バージョン・IV・タグ・暗号文の4つで構成される', () => {
    const fields = encryptSecret('x', { key: KEY }).split('.');

    expect(fields).toHaveLength(4);
    expect(fields[0]).toBe(ENCRYPTION_VERSION);
    expect(Buffer.from(fields[1] ?? '', 'base64url')).toHaveLength(
      ENCRYPTION_IV_BYTES,
    );
    expect(Buffer.from(fields[2] ?? '', 'base64url')).toHaveLength(
      ENCRYPTION_TAG_BYTES,
    );
  });

  it('別の鍵では復号できない', () => {
    const payload = encryptSecret('x', { key: KEY });

    expect(() => decryptSecret(payload, { key: OTHER_KEY })).toThrow(
      DecryptionError,
    );
  });

  it('暗号文を1バイト変えると復号できない', () => {
    const fields = encryptSecret('abcdefgh', { key: KEY }).split('.');
    const ciphertext = Buffer.from(fields[3] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x01;
    fields[3] = ciphertext.toString('base64url');

    expect(() => decryptSecret(fields.join('.'), { key: KEY })).toThrow(
      DecryptionError,
    );
  });

  it('認証タグを変えると復号できない', () => {
    const fields = encryptSecret('abcdefgh', { key: KEY }).split('.');
    const tag = Buffer.from(fields[2] ?? '', 'base64url');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    fields[2] = tag.toString('base64url');

    expect(() => decryptSecret(fields.join('.'), { key: KEY })).toThrow(
      DecryptionError,
    );
  });

  it('IVを変えると復号できない', () => {
    const fields = encryptSecret('abcdefgh', { key: KEY }).split('.');
    const iv = Buffer.from(fields[1] ?? '', 'base64url');
    iv[0] = (iv[0] ?? 0) ^ 0x01;
    fields[1] = iv.toString('base64url');

    expect(() => decryptSecret(fields.join('.'), { key: KEY })).toThrow(
      DecryptionError,
    );
  });

  it.each([
    ['空文字', ''],
    ['区切りが足りない', 'v1.aaa.bbb'],
    ['区切りが多い', 'v1.aaa.bbb.ccc.ddd'],
    ['バージョンが違う', 'v2.aaa.bbb.ccc'],
    ['base64url でない文字が入る', 'v1.a@a.bbb.ccc'],
  ])('形式が壊れている場合は復号しない（%s）', (_label, payload) => {
    expect(() => decryptSecret(payload, { key: KEY })).toThrow(DecryptionError);
  });

  it('IVの長さが違う場合は復号しない', () => {
    const fields = encryptSecret('x', { key: KEY }).split('.');
    fields[1] = Buffer.alloc(8).toString('base64url');

    expect(() => decryptSecret(fields.join('.'), { key: KEY })).toThrow(
      DecryptionError,
    );
  });

  it('復号エラーのメッセージに暗号文も鍵も含めない', () => {
    const payload = encryptSecret('x', { key: KEY });

    try {
      decryptSecret(payload, { key: OTHER_KEY });
      expect.unreachable('復号できてしまった');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(payload);
      expect(message).not.toContain(KEY.toString('base64'));
      expect(message).toBe('暗号化された値を復号できませんでした');
    }
  });

  it('鍵の長さが32バイトでなければ暗号化しない', () => {
    expect(() => encryptSecret('x', { key: randomBytes(16) })).toThrow(
      EncryptionKeyError,
    );
  });

  it('鍵の長さが32バイトでなければ復号しない', () => {
    const payload = encryptSecret('x', { key: KEY });

    expect(() => decryptSecret(payload, { key: randomBytes(16) })).toThrow(
      EncryptionKeyError,
    );
  });
});

describe('AAD（追加認証データ）', () => {
  const aad = 'wordpress_connection:blog-1:app_password';

  it('同じAADなら復号できる', () => {
    const payload = encryptSecret('pw', { key: KEY, aad });

    expect(decryptSecret(payload, { key: KEY, aad }).expose()).toBe('pw');
  });

  it('別の行のAADでは復号できない（暗号文の移し替えを防ぐ）', () => {
    const payload = encryptSecret('pw', { key: KEY, aad });

    expect(() =>
      decryptSecret(payload, {
        key: KEY,
        aad: 'wordpress_connection:blog-2:app_password',
      }),
    ).toThrow(DecryptionError);
  });

  it('別の列のAADでは復号できない', () => {
    const payload = encryptSecret('pw', { key: KEY, aad });

    expect(() =>
      decryptSecret(payload, {
        key: KEY,
        aad: 'wordpress_connection:blog-1:wp_username',
      }),
    ).toThrow(DecryptionError);
  });

  it('AADを付けて暗号化した値をAAD無しでは復号できない', () => {
    const payload = encryptSecret('pw', { key: KEY, aad });

    expect(() => decryptSecret(payload, { key: KEY })).toThrow(DecryptionError);
  });
});

describe('isEncryptedPayload / isEmptyPayload', () => {
  it('暗号化した値を暗号文と判定する', () => {
    expect(isEncryptedPayload(encryptSecret('x', { key: KEY }))).toBe(true);
  });

  it('平文を暗号文と判定しない', () => {
    expect(isEncryptedPayload('plain-text')).toBe(false);
  });

  it('空文字を暗号化したものを「中身なし」と判定する', () => {
    expect(isEmptyPayload(encryptSecret('', { key: KEY }))).toBe(true);
  });

  it('値の入った暗号文を「中身なし」と判定しない', () => {
    expect(isEmptyPayload(encryptSecret('pw', { key: KEY }))).toBe(false);
  });

  it('形式が壊れている場合も「中身なし」として扱う', () => {
    expect(isEmptyPayload('broken')).toBe(true);
  });
});

describe('Secret', () => {
  it('expose() でだけ中身を取り出せる', () => {
    expect(new Secret('pw').expose()).toBe('pw');
  });

  it('JSON.stringify に中身が出ない', () => {
    const json = JSON.stringify({ appPassword: new Secret('pw') });

    expect(json).not.toContain('pw');
    expect(json).toBe('{"appPassword":"[REDACTED]"}');
  });

  it('文字列連結・テンプレートに中身が出ない', () => {
    const secret = new Secret('pw');

    expect(`${secret}`).toBe('[REDACTED]');
    expect(String(secret)).toBe('[REDACTED]');
    expect(`${secret}`).not.toContain('pw');
  });

  it('util.inspect（console.log の実体）に中身が出ない', () => {
    const output = inspect(
      { nested: { secret: new Secret('pw') } },
      { depth: 5 },
    );

    expect(output).not.toContain('pw');
    expect(output).toContain('[REDACTED]');
  });

  it('共通ロガーへ渡しても中身が出ない', () => {
    const entries: LogEntry[] = [];
    const log = createLogger({ sink: (entry) => entries.push(entry) });

    log.info('接続を保存した', { credential: new Secret('pw') });

    expect(JSON.stringify(entries)).not.toContain('pw');
  });

  it('Object.prototype.toString でも中身が出ない', () => {
    expect(Object.prototype.toString.call(new Secret('pw'))).toBe(
      '[object Secret]',
    );
  });

  it('isEmpty で中身を出さずに未設定を判定できる', () => {
    expect(new Secret('').isEmpty).toBe(true);
    expect(new Secret('pw').isEmpty).toBe(false);
  });
});

describe('getEncryptionKey', () => {
  const KEY_B64 = Buffer.alloc(32, 4).toString('base64');

  beforeEach(() => {
    resetEncryptionKeyCache();
    resetServerEnvCache();
  });

  afterEach(() => {
    resetEncryptionKeyCache();
    resetServerEnvCache();
    for (const name of Object.keys(REQUIRED_ENV)) {
      delete process.env[name];
    }
  });

  function setEnv(overrides: Record<string, string> = {}): void {
    for (const [name, value] of Object.entries({
      ...REQUIRED_ENV,
      ...overrides,
    })) {
      process.env[name] = value;
    }
  }

  it('環境変数から鍵を読み、キャッシュする', () => {
    setEnv({ ENCRYPTION_KEY: KEY_B64 });

    const first = getEncryptionKey();
    const second = getEncryptionKey();

    expect(first).toHaveLength(ENCRYPTION_KEY_BYTES);
    expect(second).toBe(first);
  });

  it('読み込んだ鍵で往復できる', () => {
    setEnv({ ENCRYPTION_KEY: KEY_B64 });

    const key = getEncryptionKey();
    const payload = encryptSecret('pw', { key });

    expect(decryptSecret(payload, { key }).expose()).toBe('pw');
  });

  it('環境変数が未設定なら例外を投げる', () => {
    resetEncryptionKeyCache();
    resetServerEnvCache();

    expect(() => getEncryptionKey()).toThrow();
  });
});

describe('decodeEncryptionKey', () => {
  it('base64 の32バイトを鍵として読める', () => {
    const key = randomBytes(ENCRYPTION_KEY_BYTES);

    expect(decodeEncryptionKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it('前後の空白を無視する', () => {
    const key = randomBytes(ENCRYPTION_KEY_BYTES);

    expect(
      decodeEncryptionKey(`  ${key.toString('base64')}  `).equals(key),
    ).toBe(true);
  });

  it.each([
    ['短い', Buffer.alloc(16).toString('base64')],
    ['長い', Buffer.alloc(64).toString('base64')],
    ['空', ''],
    ['base64 でない文字が混ざる', '*'.repeat(44)],
  ])('不正な鍵を拒否する（%s）', (_label, value) => {
    expect(() => decodeEncryptionKey(value)).toThrow(EncryptionKeyError);
    expect(isValidEncryptionKey(value)).toBe(false);
  });

  it('base64 として復元できない値を拒否する（文字の取りこぼし）', () => {
    // Buffer.from は不正な文字を黙って捨てる。32バイトになっても通さない
    const body = Buffer.alloc(32, 5).toString('base64').replace(/=+$/, '');

    expect(() => decodeEncryptionKey(`${body}!`)).toThrow(EncryptionKeyError);
  });

  it('base64 として正規でない値を拒否する（末尾の余りビット）', () => {
    // 43文字目には2ビットの余りがある。そこが 0 でない値は再エンコードで
    // 別の文字になる。打ち間違えを見逃さないため拒否する
    const nonCanonical = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQB';

    expect(Buffer.from(nonCanonical, 'base64')).toHaveLength(32);
    expect(() => decodeEncryptionKey(nonCanonical)).toThrow(EncryptionKeyError);
  });

  it('エラーメッセージに鍵の値を含めない', () => {
    const value = Buffer.alloc(16, 7).toString('base64');

    try {
      decodeEncryptionKey(value);
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('.env.example の値は有効な鍵である', () => {
    expect(
      isValidEncryptionKey('ZmFrZS1rZXktZm9yLWxvY2FsLWRldi0zMi1ieXRlcyE='),
    ).toBe(true);
  });
});
