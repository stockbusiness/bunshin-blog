import { describe, expect, it } from 'vitest';
import {
  buildSessionCookie,
  createSessionToken,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from '@/modules/auth';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const NOW = new Date('2026-08-07T00:00:00Z');

function make(userId = 'user-1', now: Date = NOW): string {
  return createSessionToken(userId, { secret: SECRET, now: () => now });
}

describe('createSessionToken / verifySessionToken', () => {
  it('発行したトークンを検証できる', () => {
    const session = verifySessionToken(make(), {
      secret: SECRET,
      now: () => NOW,
    });

    expect(session?.userId).toBe('user-1');
  });

  it('30日の有効期限を持つ', () => {
    const session = verifySessionToken(make(), {
      secret: SECRET,
      now: () => NOW,
    });
    const days = ((session?.expiresAt ?? 0) - NOW.getTime()) / 86_400_000;

    expect(days).toBe(30);
  });

  it('別の鍵で署名されたトークンを拒否する', () => {
    const forged = createSessionToken('user-1', {
      secret: OTHER_SECRET,
      now: () => NOW,
    });

    expect(verifySessionToken(forged, { secret: SECRET, now: () => NOW })).toBe(
      null,
    );
  });

  it('本文を書き換えたトークンを拒否する', () => {
    const token = make('user-1');
    const [body, signature] = token.split('.');
    const tamperedBody = Buffer.from(
      JSON.stringify({
        userId: 'user-2',
        issuedAt: NOW.getTime(),
        expiresAt: NOW.getTime() + 86_400_000,
      }),
    )
      .toString('base64url')
      .replace(/=+$/, '');

    expect(body).not.toBe(tamperedBody);
    expect(
      verifySessionToken(`${tamperedBody}.${signature ?? ''}`, {
        secret: SECRET,
        now: () => NOW,
      }),
    ).toBe(null);
  });

  it('期限切れのトークンを拒否する', () => {
    const later = new Date(NOW.getTime() + 31 * 86_400_000);

    expect(
      verifySessionToken(make(), { secret: SECRET, now: () => later }),
    ).toBe(null);
  });

  it('形式が壊れたトークンを拒否する', () => {
    for (const value of ['', 'no-dot', '.', 'a.b.c', 'Zm9v.invalid']) {
      expect(
        verifySessionToken(value, { secret: SECRET, now: () => NOW }),
      ).toBe(null);
    }
  });
});

describe('buildSessionCookie', () => {
  it('HttpOnly と SameSite を付ける', () => {
    const cookie = buildSessionCookie('token-value');

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token-value`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });
});

describe('readSessionCookie', () => {
  it('Cookieヘッダから値を取り出す', () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=abc; x=2`)).toBe(
      'abc',
    );
  });

  it('該当が無ければ null', () => {
    expect(readSessionCookie(null)).toBe(null);
    expect(readSessionCookie('')).toBe(null);
    expect(readSessionCookie('other=1')).toBe(null);
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBe(null);
  });
});
