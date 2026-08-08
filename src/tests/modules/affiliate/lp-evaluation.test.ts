import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  HTTP_ERROR_CODES,
  HttpFetchError,
  type SafeFetchResponse,
  type safeFetch,
} from '@/lib/http';
import {
  LP_ERROR_CODES,
  countFormFields,
  detectMobileReady,
  evaluateHtml,
  evaluateLandingPage,
} from '@/modules/affiliate';

/**
 * LPの自動評価（TASKS D-2、SPEC 9.2.3・14.3）。
 *
 * 完了条件は「**SSRF対策を満たし、フォーム項目数・ページ長・viewportを
 * 判定**」。SSRF対策そのものは `safeFetch`（C-7）が担うので、ここで
 * 確かめるのは**必ずそれを通しているか**と、判定の中身。
 */

const LP_URL = 'https://lp.example.com/offer';

interface Recorded {
  url: string | URL;
  options: Parameters<typeof safeFetch>[1];
}

function createFetch(response: Partial<SafeFetchResponse> | Error): {
  fetchFn: typeof safeFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];

  const fetchFn = (async (url, options) => {
    calls.push({ url, options });

    if (response instanceof Error) {
      throw response;
    }

    return {
      status: 200,
      headers: {},
      contentType: 'text/html',
      body: '',
      finalUrl: String(url),
      redirectCount: 0,
      ...response,
    };
  }) as typeof safeFetch;

  return { fetchFn, calls };
}

describe('countFormFields', () => {
  it('入力欄を数える', () => {
    const html = `
      <form>
        <input type="text" name="name">
        <input type="email" name="email">
        <input name="tel">
      </form>`;

    expect(countFormFields(html)).toEqual({ formFields: 3, inputElements: 3 });
  });

  /**
   * **`hidden` を数えない。** CSRFトークンなどで数個〜十数個入ることがあり、
   * そのまま数えると3項目のフォームが「11以上＝0点」になる（SPEC 9.2.3）。
   */
  it('hidden を項目として数えない', () => {
    const html = `
      <form>
        <input type="hidden" name="_token" value="x">
        <input type="hidden" name="_ref" value="y">
        <input type="text" name="name">
      </form>`;

    expect(countFormFields(html)).toEqual({ formFields: 1, inputElements: 3 });
  });

  it.each([['submit'], ['button'], ['reset'], ['image']])(
    '%s を項目として数えない',
    (type) => {
      const html = `<input type="text"><input type="${type}">`;

      expect(countFormFields(html).formFields).toBe(1);
    },
  );

  /**
   * 利用者から見れば同じ「入力項目」。外すと選択式中心のフォームが
   * 不当に高く出る。
   */
  it('select と textarea も数える', () => {
    const html = `
      <form>
        <input type="text">
        <select name="pref"><option>東京</option></select>
        <textarea name="note"></textarea>
      </form>`;

    expect(countFormFields(html).formFields).toBe(3);
  });

  it('type の指定が無ければ text として数える', () => {
    expect(countFormFields('<input name="a">').formFields).toBe(1);
  });

  it('type の大文字小文字を区別しない', () => {
    expect(countFormFields('<INPUT TYPE="HIDDEN">').formFields).toBe(0);
  });

  it('引用符なしの属性も読む', () => {
    expect(countFormFields('<input type=hidden name=a>').formFields).toBe(0);
  });

  it('シングルクォートの属性も読む', () => {
    expect(countFormFields("<input type='hidden'>").formFields).toBe(0);
  });

  /** スクリプトやコメントの中の文字列を数えない */
  it('script の中を数えない', () => {
    const html = `
      <script>document.write('<input type="text">');</script>
      <input type="text">`;

    expect(countFormFields(html).formFields).toBe(1);
  });

  it('コメントの中を数えない', () => {
    const html = '<!-- <input type="text"> --><input type="text">';

    expect(countFormFields(html).formFields).toBe(1);
  });

  it('フォームが無ければ0', () => {
    expect(countFormFields('<html><body><p>本文</p></body></html>')).toEqual({
      formFields: 0,
      inputElements: 0,
    });
  });
});

describe('detectMobileReady', () => {
  it('width=device-width があれば true', () => {
    expect(
      detectMobileReady(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      ),
    ).toBe(true);
  });

  it('initial-scale=1 だけでも true', () => {
    expect(
      detectMobileReady('<meta name="viewport" content="initial-scale=1.0">'),
    ).toBe(true);
  });

  /**
   * **固定幅は「指定はあるがスマートフォン向けではない」。**
   * 足切り「LPがスマートフォン非対応」に当たる（SPEC 9.2.3）。
   */
  it('固定幅の指定は false', () => {
    expect(
      detectMobileReady('<meta name="viewport" content="width=1024">'),
    ).toBe(false);
  });

  it('viewport の指定が無ければ false', () => {
    expect(detectMobileReady('<meta charset="utf-8">')).toBe(false);
  });

  it('属性名の大文字小文字を区別しない', () => {
    expect(
      detectMobileReady('<META NAME="VIEWPORT" CONTENT="WIDTH=DEVICE-WIDTH">'),
    ).toBe(true);
  });

  it('script の中の記述に反応しない', () => {
    expect(
      detectMobileReady(
        '<script>var s = \'<meta name="viewport" content="width=device-width">\';</script>',
      ),
    ).toBe(false);
  });
});

describe('evaluateHtml', () => {
  it('3項目をまとめて返す', () => {
    const html =
      '<html><head><meta name="viewport" content="width=device-width"></head>' +
      '<body><form><input type="text"><input type="hidden"></form></body></html>';

    expect(evaluateHtml(html, LP_URL)).toEqual({
      formFields: 1,
      inputElements: 2,
      mobileReady: true,
      contentLength: Buffer.byteLength(html, 'utf8'),
      finalUrl: LP_URL,
    });
  });

  // 日本語のLPで長さがずれない
  it('ページ長はバイト数で数える', () => {
    expect(evaluateHtml('あ', LP_URL).contentLength).toBe(3);
  });
});

describe('evaluateLandingPage', () => {
  /**
   * **完了条件の中心。** 宛先はモニターが入力したURLなので、
   * `safeFetch` を通さないと内部ネットワークへ到達しうる（SPEC 14.3）。
   */
  it('safeFetch にSSRF対策の条件を渡す', async () => {
    const { fetchFn, calls } = createFetch({ body: '<html></html>' });

    await evaluateLandingPage({ landingPageUrl: LP_URL, fetchFn });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LP_URL);
    expect(calls[0]?.options).toMatchObject({
      method: 'GET',
      // タイムアウト・最大サイズ・Content-Type（SPEC 14.3）
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    });
    expect(calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.options?.maxBytes).toBeGreaterThan(0);
  });

  it('転送後のURLを返す', async () => {
    const { fetchFn } = createFetch({
      body: '<html></html>',
      finalUrl: 'https://lp.example.com/final',
    });

    const result = await evaluateLandingPage({
      landingPageUrl: LP_URL,
      fetchFn,
    });

    expect(result.finalUrl).toBe('https://lp.example.com/final');
  });

  /**
   * **到達できない理由を細かく返さない**（SPEC 14.3）。
   * 到達禁止アドレスと接続失敗を区別すると、応答の違いで内部の構成を
   * 調べられる。
   */
  it.each([
    [HTTP_ERROR_CODES.blockedAddress, '10.0.0.1 は到達禁止'],
    [HTTP_ERROR_CODES.dnsFailed, 'internal.corp を解決できない'],
    [HTTP_ERROR_CODES.timeout, '応答なし'],
    [HTTP_ERROR_CODES.requestFailed, 'TLSに失敗'],
  ])('%s を同じコードに揃える', async (code, detail) => {
    const { fetchFn } = createFetch(new HttpFetchError(code, detail));

    const error: unknown = await evaluateLandingPage({
      landingPageUrl: LP_URL,
      fetchFn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(LP_ERROR_CODES.lpUnreachable);
    // 内部の宛先をメッセージに出さない
    expect((error as AppError).message).not.toContain(detail);
  });

  // これは切り分けの役に立つ（モニターがURLを直せる）
  it('HTMLでなければ専用のコードで返す', async () => {
    const { fetchFn } = createFetch(
      new HttpFetchError(
        HTTP_ERROR_CODES.unexpectedContentType,
        'application/pdf',
      ),
    );

    await expect(
      evaluateLandingPage({ landingPageUrl: LP_URL, fetchFn }),
    ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpNotHtml });
  });

  it.each([[404], [410], [500], [503]])(
    'HTTP %s を失敗として扱う',
    async (status) => {
      const { fetchFn } = createFetch({ status, body: '<html></html>' });

      await expect(
        evaluateLandingPage({ landingPageUrl: LP_URL, fetchFn }),
      ).rejects.toMatchObject({ code: LP_ERROR_CODES.lpUnavailable });
    },
  );

  it.each([[200], [204], [301]])('HTTP %s は評価する', async (status) => {
    const { fetchFn } = createFetch({ status, body: '<html></html>' });

    await expect(
      evaluateLandingPage({ landingPageUrl: LP_URL, fetchFn }),
    ).resolves.toMatchObject({ formFields: 0 });
  });
});
