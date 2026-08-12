import { describe, expect, it } from 'vitest';
import {
  AUTHORIZE_STATE_TTL_MINUTES,
  buildAuthorizeUrl,
  createAuthorizeState,
  matchesRequestedSite,
  verifyAuthorizeState,
  type AuthorizeState,
} from '@/modules/wordpress';

/**
 * WordPress の認可フロー（TASKS I-8、SPEC 7.1 v2.3）。
 *
 * ここで確かめるのは、**細工した戻りを受け付けないこと。**
 * 署名が無い・照合が甘いと、**攻撃者のサイトを他人のブログ枠に
 * つながせられる。**
 */

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-08-12T03:00:00.000Z');
const REQUEST = {
  userId: 'user-1',
  blogId: 'blog-1',
  siteUrl: 'https://example.com',
};

function state(overrides: Partial<typeof REQUEST> = {}): string {
  return createAuthorizeState(
    { ...REQUEST, ...overrides },
    { secret: SECRET, now: NOW },
  );
}

function verify(token: string, now: Date = NOW): AuthorizeState | null {
  return verifyAuthorizeState(token, { secret: SECRET, now });
}

describe('依頼に署名する', () => {
  it('利用者・ブログ・サイトURLを持ち帰れる', () => {
    expect(verify(state())).toMatchObject({
      userId: 'user-1',
      blogId: 'blog-1',
      siteUrl: 'https://example.com',
    });
  });

  /** **末尾のスラッシュや大文字で一致しないと、戻りを弾いてしまう** */
  it('サイトURLは正規化して入れる', () => {
    expect(verify(state({ siteUrl: 'HTTPS://Example.com/' }))?.siteUrl).toBe(
      'https://example.com',
    );
  });
});

describe('受け付けない戻り', () => {
  it('署名が違えば受け付けない', () => {
    expect(
      verifyAuthorizeState(state(), { secret: 'b'.repeat(48), now: NOW }),
    ).toBeNull();
  });

  /** **中身を書き換えて署名を付け直せない**（別のブログを指せない） */
  it('中身だけ書き換えたものを受け付けない', () => {
    const [body, signature] = state().split('.') as [string, string];
    const tampered = Buffer.from(
      JSON.stringify({
        userId: 'user-1',
        blogId: 'blog-2',
        siteUrl: 'https://example.com',
        expiresAt: NOW.getTime() + 60_000,
      }),
    )
      .toString('base64url')
      .replace(/=+$/, '');

    expect(verify(`${tampered}.${signature}`)).toBeNull();
    expect(body).not.toBe(tampered);
  });

  /** **承認は目の前で行う操作。** 時間を置いて戻ってくる理由が無い */
  it('期限を過ぎたものを受け付けない', () => {
    const later = new Date(
      NOW.getTime() + AUTHORIZE_STATE_TTL_MINUTES * 60_000 + 1_000,
    );

    expect(verify(state(), later)).toBeNull();
  });

  it.each(['', '.', 'abc', 'a.b.c'])(
    '形式が壊れたもの（%s）を受け付けない',
    (token) => {
      expect(verify(token)).toBeNull();
    },
  );
});

/**
 * **戻りの `site_url` が依頼と違うのは、依頼と違うサイトで
 * 承認されたということ**
 */
describe('戻ってきたサイトの照合', () => {
  const requested = verify(state()) as AuthorizeState;

  it('同じサイトなら通る', () => {
    expect(matchesRequestedSite(requested, 'https://example.com')).toBe(true);
  });

  it('表記が違っても同じサイトなら通る', () => {
    expect(matchesRequestedSite(requested, 'https://Example.com/')).toBe(true);
  });

  it('違うサイトは通さない', () => {
    expect(matchesRequestedSite(requested, 'https://evil.example')).toBe(false);
  });

  /** **確かめられないまま繋ぐと、署名だけが根拠になる** */
  it.each([null, '', '   '])('載っていなければ通さない（%s）', (value) => {
    expect(matchesRequestedSite(requested, value)).toBe(false);
  });

  /** 形式が壊れていても落ちない（正規化が例外を投げる） */
  it('URLとして読めなければ通さない', () => {
    expect(matchesRequestedSite(requested, 'not a url')).toBe(false);
  });
});

describe('承認画面のURL', () => {
  const url = new URL(
    buildAuthorizeUrl({
      siteUrl: 'https://example.com',
      successUrl:
        'https://bunshin.example/api/blogs/blog-1/wordpress/authorized',
      state: 'STATE',
    }),
  );

  it('WordPress の承認画面を指す', () => {
    expect(url.origin).toBe('https://example.com');
    expect(url.pathname).toBe('/wp-admin/authorize-application.php');
  });

  it('戻り先と state を載せる', () => {
    expect(url.searchParams.get('success_url')).toBe(
      'https://bunshin.example/api/blogs/blog-1/wordpress/authorized',
    );
    expect(url.searchParams.get('state')).toBe('STATE');
  });

  /**
   * **拒否したときも戻す。** 戻らないと、モニターは WordPress の
   * 画面に取り残されて「何が起きたのか」が分からない
   */
  it('拒否したときの戻り先も載せる', () => {
    expect(url.searchParams.get('reject_url')).toBe(
      url.searchParams.get('success_url'),
    );
  });

  /** **平文の http は `normalizeSiteUrl` が拒む**（Basic 認証で流れる） */
  it('http のサイトは組み立てられない', () => {
    expect(() =>
      buildAuthorizeUrl({
        siteUrl: 'http://example.com',
        successUrl: 'https://bunshin.example/back',
        state: 'STATE',
      }),
    ).toThrow();
  });
});
