import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_ERROR_CODES,
  appendSubId,
  buildAffiliateLink,
  buildRedirectUrl,
  buildSubId,
  type LinkableOffer,
} from '@/modules/affiliate';

/**
 * リンクの組み立て（TASKS D-1、OPEN_QUESTIONS Q-001・Q-014）。
 *
 * 完了条件は「**リンクの組み立てが1関数に集約され、`REDIRECT` /
 * `DIRECT` を切り替えられる**」「**全案件にサブIDが付く**」。
 *
 * ここが唯一の組み立て場所なので、**呼び出し側が分岐を書かなくて済むか**を
 * 直接見る。
 */

const BASE_URL = 'https://app.example.com';
const CONTENT_ITEM_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function offer(overrides: Partial<LinkableOffer> = {}): LinkableOffer {
  return {
    affiliateUrl: 'https://asp.example/click?a=xxxx',
    linkMode: 'DIRECT',
    subIdParam: 'sub',
    ...overrides,
  };
}

function build(overrides: Partial<LinkableOffer> = {}, code?: string) {
  return buildAffiliateLink({
    offer: offer(overrides),
    slotNumber: 2,
    contentItemId: CONTENT_ITEM_ID,
    ...(code === undefined ? {} : { redirectCode: code }),
    baseUrl: BASE_URL,
  });
}

describe('buildSubId', () => {
  // スロット番号を先頭に置くと、ASPの管理画面でどのブログか分かる
  it('スロット番号と記事IDを繋ぐ', () => {
    expect(buildSubId({ slotNumber: 2, contentItemId: 'item-1' })).toBe(
      '2-item-1',
    );
  });
});

describe('appendSubId', () => {
  it('パラメータ名が指定されていれば付ける', () => {
    const result = appendSubId(
      'https://asp.example/click?a=xxxx',
      'sub',
      '2-item-1',
    );

    expect(result.url).toBe('https://asp.example/click?a=xxxx&sub=2-item-1');
    expect(result.subId).toBe('2-item-1');
  });

  /**
   * ASPの情報がゼロでも案件は登録でき、サブIDが付かないだけになる（Q-014）。
   */
  it.each([[null], ['']])('パラメータ名が %o なら付けない', (param) => {
    const result = appendSubId(
      'https://asp.example/click?a=xxxx',
      param,
      '2-item-1',
    );

    expect(result.url).toBe('https://asp.example/click?a=xxxx');
    expect(result.subId).toBeNull();
  });

  /**
   * **同じ名前が既にあれば置き換える。** 2つ付けると、どちらが採用されるかが
   * ASP任せになる。
   */
  it('既にある同名のパラメータを置き換える', () => {
    const result = appendSubId(
      'https://asp.example/click?a=xxxx&sub=old',
      'sub',
      '2-item-1',
    );

    expect(result.url).toBe('https://asp.example/click?a=xxxx&sub=2-item-1');
    expect(result.url).not.toContain('old');
  });

  it('他のパラメータを壊さない', () => {
    const result = appendSubId(
      'https://asp.example/click?a=xxxx&b=yyyy',
      'sub',
      '2-item-1',
    );

    expect(result.url).toContain('a=xxxx');
    expect(result.url).toContain('b=yyyy');
  });

  it('URLとして読めなければ拒む', () => {
    expect(() => appendSubId('これはURLではない', 'sub', '2-item-1')).toThrow();
  });
});

describe('DIRECT', () => {
  it('アフィリエイトURLをそのまま埋める', () => {
    const result = build({ linkMode: 'DIRECT' });

    expect(result.linkMode).toBe('DIRECT');
    expect(result.href).toBe(
      `https://asp.example/click?a=xxxx&sub=2-${CONTENT_ITEM_ID}`,
    );
    // 飛び先は同じ
    expect(result.destinationUrl).toBe(result.href);
  });

  it('リダイレクタを経由しない', () => {
    expect(build({ linkMode: 'DIRECT' }).href).not.toContain('/go/');
  });

  // コードが無くても組み立てられる（リダイレクタを使わないため）
  it('リダイレクタのコードが無くても組み立てられる', () => {
    expect(() => build({ linkMode: 'DIRECT' })).not.toThrow();
  });
});

describe('REDIRECT', () => {
  it('リダイレクタのURLを埋める', () => {
    const result = build({ linkMode: 'REDIRECT' }, 'abc123');

    expect(result.linkMode).toBe('REDIRECT');
    expect(result.href).toBe(`${BASE_URL}/go/abc123`);
  });

  /**
   * **リダイレクタを経由してもサブIDは落とさない。**
   * リダイレクタはクリックを数え、サブIDは成果を紐づける。役割が違う（Q-001）。
   */
  it('飛び先にサブIDが残る', () => {
    const result = build({ linkMode: 'REDIRECT' }, 'abc123');

    expect(result.destinationUrl).toBe(
      `https://asp.example/click?a=xxxx&sub=2-${CONTENT_ITEM_ID}`,
    );
    expect(result.subId).toBe(`2-${CONTENT_ITEM_ID}`);
  });

  /**
   * 呼び出し側の誤り。**422 にしない** — 記事生成が「入力が悪い」と
   * 誤解して再試行を続ける。
   */
  it.each([[undefined], ['']])('コードが %o なら 500 で落とす', (code) => {
    let thrown: unknown;
    try {
      buildAffiliateLink({
        offer: offer({ linkMode: 'REDIRECT' }),
        slotNumber: 2,
        contentItemId: CONTENT_ITEM_ID,
        redirectCode: code,
        baseUrl: BASE_URL,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: AFFILIATE_ERROR_CODES.missingRedirectCode,
      status: 500,
    });
  });

  it('コードをURLとして安全に埋める', () => {
    expect(build({ linkMode: 'REDIRECT' }, 'a/b?c').href).toBe(
      `${BASE_URL}/go/a%2Fb%3Fc`,
    );
  });
});

describe('サブIDは方式によらず付く（Q-001）', () => {
  it.each<[LinkableOffer['linkMode']]>([['DIRECT'], ['REDIRECT']])(
    '%s でもサブIDが付く',
    (linkMode) => {
      const result = build({ linkMode }, 'abc123');

      expect(result.subId).toBe(`2-${CONTENT_ITEM_ID}`);
      expect(result.destinationUrl).toContain(`sub=2-${CONTENT_ITEM_ID}`);
    },
  );

  it.each<[LinkableOffer['linkMode']]>([['DIRECT'], ['REDIRECT']])(
    '%s でパラメータ名が無ければ付かない',
    (linkMode) => {
      const result = build({ linkMode, subIdParam: null }, 'abc123');

      expect(result.subId).toBeNull();
      expect(result.destinationUrl).toBe('https://asp.example/click?a=xxxx');
    },
  );
});

describe('buildRedirectUrl', () => {
  it('末尾のスラッシュを重ねない', () => {
    expect(buildRedirectUrl('abc', 'https://app.example.com/')).toBe(
      'https://app.example.com/go/abc',
    );
    expect(buildRedirectUrl('abc', 'https://app.example.com///')).toBe(
      'https://app.example.com/go/abc',
    );
  });

  /**
   * **リクエストの `Host` から作らない**（B-10 と同じ方針）。
   * `Host` は詐称でき、記事本文へ埋まると後から直せない。
   */
  it('公開URLが未設定なら落とす', () => {
    let thrown: unknown;
    try {
      buildRedirectUrl('abc', '');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: AFFILIATE_ERROR_CODES.redirectNotConfigured,
      status: 500,
    });
  });
});
