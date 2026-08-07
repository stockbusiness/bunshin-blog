import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  getServerEnv,
  parseServerEnv,
  resetServerEnvCache,
} from '@/lib/env';

const VALID_DATABASE_URL = 'postgresql://user:s3cr3t-pw@localhost:5432/bunshin';

afterEach(() => {
  resetServerEnvCache();
});

describe('parseServerEnv', () => {
  it('必須の環境変数が揃っていれば検証を通す', () => {
    const env = parseServerEnv({ DATABASE_URL: VALID_DATABASE_URL });

    expect(env.DATABASE_URL).toBe(VALID_DATABASE_URL);
  });

  it('NODE_ENV が未設定なら development を既定値にする', () => {
    const env = parseServerEnv({ DATABASE_URL: VALID_DATABASE_URL });

    expect(env.NODE_ENV).toBe('development');
  });

  it('未設定の環境変数があれば EnvValidationError を投げる', () => {
    expect(() => parseServerEnv({})).toThrow(EnvValidationError);
  });

  it('欠落した変数名をメッセージと missing の両方に出す', () => {
    try {
      parseServerEnv({});
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const envError = error as EnvValidationError;
      expect(envError.missing).toEqual(['DATABASE_URL']);
      expect(envError.invalid).toEqual([]);
      expect(envError.message).toContain('DATABASE_URL');
      expect(envError.message).toContain('未設定の環境変数');
    }
  });

  it('空文字と空白のみの値は未設定として扱う', () => {
    for (const value of ['', '   ']) {
      try {
        parseServerEnv({ DATABASE_URL: value });
        expect.unreachable('例外が投げられていない');
      } catch (error) {
        expect((error as EnvValidationError).missing).toEqual(['DATABASE_URL']);
      }
    }
  });

  it('設定されているが不正な値は invalid に分類する', () => {
    try {
      parseServerEnv({ DATABASE_URL: 'mysql://user@localhost:3306/bunshin' });
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      const envError = error as EnvValidationError;
      expect(envError.missing).toEqual([]);
      expect(envError.invalid).toEqual(['DATABASE_URL']);
      expect(envError.message).toContain('値が不正な環境変数');
    }
  });

  it('複数の変数が同時に不正なら全ての名前を報告する', () => {
    try {
      parseServerEnv({ NODE_ENV: 'staging' });
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      const envError = error as EnvValidationError;
      expect(envError.missing).toEqual(['DATABASE_URL']);
      expect(envError.invalid).toEqual(['NODE_ENV']);
      expect(envError.message).toContain('DATABASE_URL');
      expect(envError.message).toContain('NODE_ENV');
    }
  });

  // SPEC 14.2「ログへ秘密情報を出力しない」
  it('エラーメッセージに環境変数の値を含めない', () => {
    try {
      parseServerEnv({ DATABASE_URL: 'mysql://user:s3cr3t-pw@localhost/db' });
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      const envError = error as EnvValidationError;
      expect(envError.message).not.toContain('s3cr3t-pw');
      expect(envError.message).not.toContain('mysql://');
      expect(JSON.stringify(envError.missing)).not.toContain('s3cr3t-pw');
      expect(JSON.stringify(envError.invalid)).not.toContain('s3cr3t-pw');
    }
  });

  it('スキーマに無い環境変数は結果に含めない', () => {
    const env = parseServerEnv({
      DATABASE_URL: VALID_DATABASE_URL,
      UNRELATED_SECRET: 'should-not-appear',
    });

    expect(env).not.toHaveProperty('UNRELATED_SECRET');
    expect(JSON.stringify(env)).not.toContain('should-not-appear');
  });
});

describe('getServerEnv', () => {
  it('process.env を検証して同じインスタンスを返す', () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = VALID_DATABASE_URL;

    try {
      const first = getServerEnv();
      const second = getServerEnv();

      expect(first.DATABASE_URL).toBe(VALID_DATABASE_URL);
      expect(second).toBe(first);
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });

  it('必須の環境変数が無ければ例外を投げる', () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      expect(() => getServerEnv()).toThrow(EnvValidationError);
    } finally {
      if (previous !== undefined) {
        process.env.DATABASE_URL = previous;
      }
    }
  });
});
