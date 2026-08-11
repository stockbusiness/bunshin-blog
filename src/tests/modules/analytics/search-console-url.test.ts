import { describe, expect, it } from 'vitest';
import { normalizePropertyUrl } from '@/modules/analytics';

/**
 * プロパティのURLの整え方（TASKS G-1）。
 *
 * **2つの形を両方受ける。** Search Console のプロパティには
 * ドメインプロパティ（`sc-domain:`）とURLプレフィックスがあり、
 * **モニターがどちらを作ったかはこちらで決められない。**
 * 片方しか受けないと、オンボーディングで「合っているのに弾かれる」が起きる。
 */

describe('ドメインプロパティ', () => {
  it('そのまま受ける', () => {
    expect(normalizePropertyUrl('sc-domain:example.com')).toEqual({
      propertyUrl: 'sc-domain:example.com',
      kind: 'DOMAIN',
    });
  });

  it('大文字を小文字にする', () => {
    expect(normalizePropertyUrl('sc-domain:Example.COM')).toEqual({
      propertyUrl: 'sc-domain:example.com',
      kind: 'DOMAIN',
    });
  });

  it('前後の空白を落とす', () => {
    expect(normalizePropertyUrl('  sc-domain:example.com  ')?.propertyUrl).toBe(
      'sc-domain:example.com',
    );
  });

  it.each([
    { label: 'ホストが空', raw: 'sc-domain:' },
    { label: 'パスが付いている', raw: 'sc-domain:example.com/blog' },
    { label: 'ドットが無い', raw: 'sc-domain:localhost' },
  ])('$label は弾く', ({ raw }) => {
    expect(normalizePropertyUrl(raw)).toBeNull();
  });
});

describe('URLプレフィックス', () => {
  /**
   * **末尾の `/` を足す。** Search Console は末尾まで含めて一致させるため、
   * 無いと「追加したのに見つからない」になる
   */
  it('末尾のスラッシュを足す', () => {
    expect(normalizePropertyUrl('https://example.com')).toEqual({
      propertyUrl: 'https://example.com/',
      kind: 'URL_PREFIX',
    });
  });

  it('もともと付いていればそのまま', () => {
    expect(normalizePropertyUrl('https://example.com/blog/')?.propertyUrl).toBe(
      'https://example.com/blog/',
    );
  });

  it('サブディレクトリにも足す', () => {
    expect(normalizePropertyUrl('https://example.com/blog')?.propertyUrl).toBe(
      'https://example.com/blog/',
    );
  });

  /** **問い合わせ文字列とフラグメントはプロパティの識別に使われない** */
  it('クエリとフラグメントを落とす', () => {
    expect(
      normalizePropertyUrl('https://example.com/blog?a=1#top')?.propertyUrl,
    ).toBe('https://example.com/blog/');
  });

  /**
   * **`http://` も受ける。** SPEC はモニター自身のドメインを前提としており
   * （SPEC 1.2）、Search Console には `http://` のプロパティが実在する。
   * ここで弾くと、正しい値を入れているのに連携できない
   */
  it('http のプロパティも受ける', () => {
    expect(normalizePropertyUrl('http://example.com/')).toEqual({
      propertyUrl: 'http://example.com/',
      kind: 'URL_PREFIX',
    });
  });

  it('ホストは大文字小文字を問わない', () => {
    expect(normalizePropertyUrl('https://Example.COM/')?.propertyUrl).toBe(
      'https://example.com/',
    );
  });

  it.each([
    { label: '空', raw: '' },
    { label: '空白だけ', raw: '   ' },
    { label: 'URLでない', raw: 'example.com' },
    { label: '別のスキーム', raw: 'ftp://example.com/' },
    { label: 'javascript:', raw: 'javascript:alert(1)' },
  ])('$label は弾く', ({ raw }) => {
    expect(normalizePropertyUrl(raw)).toBeNull();
  });
});
