import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  WORDPRESS_ERROR_CODES,
  assertSiteUrlUnchanged,
  deriveApiBaseUrl,
  isSameSite,
  normalizeSiteUrl,
} from '@/modules/wordpress';

/**
 * サイトURLの正規化と Q-007 の変更拒否（TASKS C-1）。
 */

describe('normalizeSiteUrl', () => {
  it.each([
    ['そのまま', 'https://example.com', 'https://example.com'],
    ['末尾のスラッシュを落とす', 'https://example.com/', 'https://example.com'],
    [
      '末尾のスラッシュが複数でも落とす',
      'https://example.com///',
      'https://example.com',
    ],
    ['前後の空白を落とす', '  https://example.com  ', 'https://example.com'],
    ['ホストを小文字にする', 'https://EXAMPLE.com', 'https://example.com'],
    [
      'サブディレクトリ設置を保つ',
      'https://example.com/blog/',
      'https://example.com/blog',
    ],
    ['既定ポートを落とす', 'https://example.com:443', 'https://example.com'],
    ['末尾のドットを落とす', 'https://example.com./', 'https://example.com'],
    [
      'サブドメインを保つ',
      'https://blog.example.co.jp',
      'https://blog.example.co.jp',
    ],
  ])('%s', (_label, input, expected) => {
    expect(normalizeSiteUrl(input)).toBe(expected);
  });

  it('スキームが無ければ https を補う', () => {
    expect(normalizeSiteUrl('example.com')).toBe('https://example.com');
    expect(normalizeSiteUrl('example.com/blog')).toBe(
      'https://example.com/blog',
    );
  });

  it.each([
    ['未入力', ''],
    ['空白のみ', '   '],
    ['http', 'http://example.com'],
    ['ftp', 'ftp://example.com'],
    ['ユーザー名とパスワードを含む', 'https://user:pw@example.com'],
    ['クエリを含む', 'https://example.com/?rest_route=/'],
    ['ハッシュを含む', 'https://example.com/#top'],
    ['既定以外のポート', 'https://example.com:8443'],
    ['ドメインでない', 'https://localhost'],
    ['ドットが無い', 'https://intranet'],
    ['.local', 'https://wp.local'],
    ['.test', 'https://wp.example.test'],
    ['IPv4リテラル', 'https://192.168.0.1'],
    ['IPv6リテラル', 'https://[::1]'],
    ['URLとして読めない', 'https://'],
  ])('拒否する（%s）', (_label, input) => {
    expect(() => normalizeSiteUrl(input)).toThrow(AppError);

    try {
      normalizeSiteUrl(input);
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(
        WORDPRESS_ERROR_CODES.invalidSiteUrl,
      );
      expect((error as AppError).status).toBe(422);
    }
  });

  it('長すぎるURLを拒否する', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;

    expect(() => normalizeSiteUrl(long)).toThrow(AppError);
  });

  it('http を指定した場合は理由を伝える（入力ミスの訂正が目的）', () => {
    try {
      normalizeSiteUrl('http://example.com');
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect((error as AppError).message).toContain('https://');
    }
  });

  it('正規化した結果をもう一度通しても変わらない', () => {
    const once = normalizeSiteUrl('HTTPS://Example.com/blog/');

    expect(normalizeSiteUrl(once)).toBe(once);
  });
});

describe('deriveApiBaseUrl', () => {
  it('REST API のベースを組み立てる', () => {
    expect(deriveApiBaseUrl('https://example.com')).toBe(
      'https://example.com/wp-json',
    );
  });

  it('サブディレクトリ設置でもベースを組み立てる', () => {
    expect(deriveApiBaseUrl('https://example.com/blog')).toBe(
      'https://example.com/blog/wp-json',
    );
  });
});

describe('isSameSite', () => {
  it('同じURLなら true', () => {
    expect(isSameSite('https://example.com', 'https://example.com')).toBe(true);
  });

  it('違うURLなら false', () => {
    expect(isSameSite('https://example.com', 'https://other.com')).toBe(false);
  });

  it('表記違いは正規化してから比べる前提で、素の比較では別物になる', () => {
    expect(isSameSite('https://example.com', 'https://example.com/')).toBe(
      false,
    );
    expect(
      isSameSite(
        normalizeSiteUrl('https://example.com'),
        normalizeSiteUrl('https://example.com/'),
      ),
    ).toBe(true);
  });
});

describe('assertSiteUrlUnchanged（OPEN_QUESTIONS Q-007）', () => {
  it('未接続なら何も起きない', () => {
    expect(() =>
      assertSiteUrlUnchanged({
        stored: undefined,
        incoming: 'https://example.com',
      }),
    ).not.toThrow();
  });

  it('同一URLの再接続は許可する（認証情報の入れ替え）', () => {
    expect(() =>
      assertSiteUrlUnchanged({
        stored: 'https://example.com',
        incoming: 'https://example.com',
      }),
    ).not.toThrow();
  });

  it('別サイトへの変更は 409 で拒否する', () => {
    try {
      assertSiteUrlUnchanged({
        stored: 'https://example.com',
        incoming: 'https://other.com',
      });
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(
        WORDPRESS_ERROR_CODES.siteUrlImmutable,
      );
      expect((error as AppError).status).toBe(409);
    }
  });

  it('サブディレクトリだけ違う場合も別サイトとして拒否する', () => {
    expect(() =>
      assertSiteUrlUnchanged({
        stored: 'https://example.com',
        incoming: 'https://example.com/blog',
      }),
    ).toThrow(AppError);
  });

  it('拒否のメッセージに保存済みのURLを含めない', () => {
    try {
      assertSiteUrlUnchanged({
        stored: 'https://secret-site.example.com',
        incoming: 'https://other.com',
      });
      expect.unreachable('通ってしまった');
    } catch (error) {
      expect((error as AppError).message).not.toContain('secret-site');
    }
  });
});
