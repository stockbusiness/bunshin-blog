import { describe, expect, it, vi } from 'vitest';
import { createWordpressClient } from '@/modules/wordpress';
import {
  deriveApiBaseUrl,
  derivePlainApiBaseUrl,
  restStyleOf,
} from '@/modules/wordpress/site-url';
import { Secret } from '@/lib/crypto';

/**
 * REST の入口を2つ持つ（Q-052）。
 *
 * **パーマリンクが「基本」のサイトでは `/wp-json/` が404になる。**
 * WordPress がその書き換え規則を作らないためで、**サイトも REST も
 * 生きている。** 本番のサイトが実際にこの状態だった（2026-08-15）。
 *
 * ここで見張るのは**宛先の組み立て**。`?` が2つになると落ちる。
 */

const SITE = 'https://example.com';

function credentials() {
  return {
    username: new Secret('monitor'),
    appPassword: new Secret('abcd efgh'),
  };
}

/** 叩かれたURLだけを覚える `safeFetch` の代わり */
function recordingFetch() {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    urls.push(url);

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      url,
    };
  });

  return { urls, fetchFn: fetchFn as never };
}

describe('入口の形', () => {
  it('ベースの末尾から形が読み取れる', () => {
    expect(restStyleOf(deriveApiBaseUrl(SITE))).toBe('pretty');
    expect(restStyleOf(derivePlainApiBaseUrl(SITE))).toBe('plain');
  });
});

describe('宛先の組み立て', () => {
  it('pretty はパスをそのまま繋ぐ', async () => {
    const { urls, fetchFn } = recordingFetch();
    const client = createWordpressClient({
      apiBaseUrl: deriveApiBaseUrl(SITE),
      credentials: credentials(),
      fetchFn,
    });

    await client.request({ path: '/wp/v2/users/me?context=edit' });

    expect(urls[0]).toBe(
      'https://example.com/wp-json/wp/v2/users/me?context=edit',
    );
  });

  /**
   * **`?` が2つになると落ちる。** `path` の問い合わせ文字列は
   * `rest_route` と併記する。
   */
  it('plain は rest_route と併記する', async () => {
    const { urls, fetchFn } = recordingFetch();
    const client = createWordpressClient({
      apiBaseUrl: derivePlainApiBaseUrl(SITE),
      credentials: credentials(),
      fetchFn,
    });

    await client.request({ path: '/wp/v2/users/me?context=edit' });

    const url = new URL(urls[0] as string);

    expect(url.origin + url.pathname).toBe('https://example.com/index.php');
    expect(url.searchParams.get('rest_route')).toBe('/wp/v2/users/me');
    expect(url.searchParams.get('context')).toBe('edit');
    // **`?` は1つだけ**
    expect((urls[0] as string).split('?')).toHaveLength(2);
  });

  it('plain で問い合わせ文字列が無くても組み立てられる', async () => {
    const { urls, fetchFn } = recordingFetch();
    const client = createWordpressClient({
      apiBaseUrl: derivePlainApiBaseUrl(SITE),
      credentials: credentials(),
      fetchFn,
    });

    await client.request({ path: '/', authenticated: false });

    expect(new URL(urls[0] as string).searchParams.get('rest_route')).toBe('/');
  });
});
