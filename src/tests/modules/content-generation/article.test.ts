import { describe, expect, it } from 'vitest';
import {
  PROMPT_ERROR_CODES,
  articleContentHash,
  assertAllowedLinks,
  assertPrDisclosure,
  assertUsedFacts,
  extractHrefs,
  operationForContentType,
} from '@/modules/content-generation';

/**
 * 生成された記事の検査（TASKS E-10、CONTENT_PLANNING 7.2）。
 *
 * > プロンプトに明記し、**かつ受信後にコードで検査する**
 *
 * **AIの申告を信じない。** 「指定されたリンクだけ使いました」と
 * 言われても、本文から実際に抜き出して確かめる。
 */

describe('リンクの抜き出し', () => {
  it.each([
    ['<a href="https://example.com/a">x</a>', ['https://example.com/a']],
    ["<a href='https://example.com/b'>x</a>", ['https://example.com/b']],
    ['<a href=https://example.com/c>x</a>', ['https://example.com/c']],
    ['<a class="x" href="/rel" rel="nofollow">y</a>', ['/rel']],
  ])('%s から抜き出す', (html, expected) => {
    expect(extractHrefs(html)).toEqual(expected);
  });

  it('複数のリンクを全て取る', () => {
    const html =
      '<p><a href="#a">1</a>と<a href="https://example.com">2</a></p>';

    expect(extractHrefs(html)).toEqual(['#a', 'https://example.com']);
  });

  it('リンクが無ければ空', () => {
    expect(extractHrefs('<p>本文だけ</p>')).toEqual([]);
  });
});

describe('許されたリンクだけを含む', () => {
  const allowed = ['#item-1', 'https://asp.example/click?a=x'];

  it('許可されたリンクは通る', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="#item-1">内部</a>',
        allowedUrls: allowed,
      }),
    ).not.toThrow();
  });

  /** **外部サイトへ自由にリンクさせない**（意図しない誘導・ASP規約） */
  it('知らないリンクは落とす', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="https://evil.example">外部</a>',
        allowedUrls: allowed,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidArticle,
        status: 422,
      }),
    );
  });

  it('1つでも混ざれば落とす', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml:
          '<a href="#item-1">よい</a><a href="https://evil.example">わるい</a>',
        allowedUrls: allowed,
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  /** ページ内アンカーは目次に使う */
  it('ページ内アンカーは通す', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="#toc-1">目次</a>',
        allowedUrls: [],
      }),
    ).not.toThrow();
  });

  /** 末尾のスラッシュや大小文字の揺れで正しいリンクを弾かない */
  it('URLの揺れを吸収する', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="https://ASP.example/click?a=x/">リンク</a>',
        allowedUrls: allowed,
      }),
    ).not.toThrow();
  });
});

describe('PR表記（SPEC 15.2）', () => {
  /** **広告リンクがあるなら要る。** 記事の種別ではなくリンクの有無で決まる */
  it('広告リンクがあるのに表記が無ければ落とす', () => {
    expect(() =>
      assertPrDisclosure({
        bodyHtml: '<p>おすすめです</p>',
        hasAffiliateLink: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it.each([
    ['<p>本記事は広告を含みます</p>'],
    ['<p>【PR】おすすめ</p>'],
    ['<p>アフィリエイト広告を利用しています</p>'],
    ['<p>プロモーションを含みます</p>'],
  ])('%s は表記として認める', (bodyHtml) => {
    expect(() =>
      assertPrDisclosure({ bodyHtml, hasAffiliateLink: true }),
    ).not.toThrow();
  });

  it('広告リンクが無ければ表記は要らない', () => {
    expect(() =>
      assertPrDisclosure({
        bodyHtml: '<p>ただの記事</p>',
        hasAffiliateLink: false,
      }),
    ).not.toThrow();
  });
});

describe('使った事実の照合', () => {
  /** **知らない事実IDを申告させない** */
  it('渡していない事実は落とす', () => {
    expect(() =>
      assertUsedFacts({
        usedFactIds: ['fact-x'],
        availableFactIds: ['fact-1'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it('渡した事実だけなら通る', () => {
    expect(() =>
      assertUsedFacts({
        usedFactIds: ['fact-1'],
        availableFactIds: ['fact-1', 'fact-2'],
      }),
    ).not.toThrow();
  });

  it('1件も使わなくても通る', () => {
    expect(() =>
      assertUsedFacts({ usedFactIds: [], availableFactIds: ['fact-1'] }),
    ).not.toThrow();
  });
});

describe('本文のハッシュ', () => {
  it('同じ内容なら同じ値', () => {
    const a = articleContentHash({ title: 'T', bodyHtml: '<p>x</p>' });
    const b = articleContentHash({ title: 'T', bodyHtml: '<p>x</p>' });

    expect(a).toBe(b);
  });

  it('タイトルが変われば違う値', () => {
    expect(articleContentHash({ title: 'A', bodyHtml: '<p>x</p>' })).not.toBe(
      articleContentHash({ title: 'B', bodyHtml: '<p>x</p>' }),
    );
  });
});

describe('記事の種別から段を決める', () => {
  /** **呼び出し側にモデル名を書かせない**（E-3） */
  it.each([
    ['AFFILIATE', 'PRIORITY_ARTICLE'],
    ['COMPARISON', 'COMPARISON'],
    ['INFORMATIONAL', 'ARTICLE_BODY'],
    ['FAQ', 'ARTICLE_BODY'],
  ])('%s → %s', (contentType, expected) => {
    expect(operationForContentType(contentType)).toBe(expected);
  });
});
