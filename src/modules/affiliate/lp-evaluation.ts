/**
 * LPの自動評価（TASKS D-2、SPEC 9.2.3・14.3）。
 *
 * `landing_page_url` のHTMLを取得し、**フォーム項目数・ページ長・viewport
 * 指定の有無**を機械判定する。
 *
 * ## 宛先はモニターが入力したURL
 *
 * **必ず `safeFetch` を通す**（C-7、SPEC 14.3）。`fetch` を直接呼ばない。
 * 内部ネットワークへ向けたURLを入れられると、応答の違いで社内の構成を
 * 調べられる（SSRF）。
 *
 * ## HTMLを構文解析しない
 *
 * 外部ライブラリを足さず、正規表現で必要な2つだけを取る。**求めているのは
 * 「フォームの項目が何個あるか」と「viewport の指定があるか」だけ**で、
 * DOMを組み立てる必要が無い。壊れたHTMLでも数えられるほうが、この用途には
 * 向いている（LPは広告用に手書きされることが多い）。
 *
 * ## 判定できなかったときは NULL のまま
 *
 * **推測で埋めない。** 取得に失敗した案件を「フォーム項目0個（＝20点）」と
 * 扱うと、届かないLPが最高得点になる。
 */

import { HTTP_ERROR_CODES, isHttpFetchError, safeFetch } from '@/lib/http';
import { lpFetchFailedError, LP_ERROR_CODES } from './errors';

/** LPの取得に許す時間。案件登録の画面から同期で呼べる範囲に収める */
export const LP_TIMEOUT_MS = 10_000;

/**
 * 読み込む最大バイト数。
 *
 * **超えた分は切り捨てず、失敗として扱う**（`safeFetch` の既定）。
 * 途中まで読んだHTMLで数えると、フォーム項目を数え落とす。
 */
export const LP_MAX_BYTES = 2 * 1024 * 1024;

/** HTMLでなければ判定しない（SPEC 14.3 の Content-Type 確認） */
export const LP_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'] as const;

/**
 * 「フォーム項目5個以下＝20点」の区切り（SPEC 9.2.3）。
 *
 * 判定に使うのは D-2 ではなく F-2（案件選定）。ここでは数えるだけ。
 */
export const LP_FORM_FIELDS_GOOD = 5;
export const LP_FORM_FIELDS_FAIR = 10;

export interface LpEvaluation {
  /** 利用者が入力する項目の数 */
  formFields: number;
  /** `<input>` の総数（`hidden` などを含む生の数） */
  inputElements: number;
  /** viewport の指定があり、端末幅に追随するか */
  mobileReady: boolean;
  /** 取得したHTMLのバイト数 */
  contentLength: number;
  /** 転送をたどった最終的なURL */
  finalUrl: string;
}

/**
 * 数えない `<input>` の `type`。
 *
 * **`hidden` を数えない。** CSRFトークンなどで数個〜十数個入ることがあり、
 * そのまま数えると3項目のフォームが「11以上＝0点」になる。SPEC 9.2.3 の
 * 区分も「フォーム項目」と書かれており、そちらに合わせる。
 *
 * ボタン類も利用者が「入力する」項目ではない。
 */
const IGNORED_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
]);

/** タグの属性を素朴に読む。属性名は小文字で返す */
function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  let match = pattern.exec(tag);
  while (match !== null) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attributes[name] = value;
    match = pattern.exec(tag);
  }

  return attributes;
}

/** コメントと `<script>` `<style>` の中身を落とす */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
}

/**
 * 利用者が入力する項目を数える。
 *
 * `<input>` に加えて `<select>` `<textarea>` も数える。**利用者から見れば
 * 同じ「入力項目」**で、これらを外すと選択式中心のフォームが不当に高く出る。
 */
export function countFormFields(html: string): {
  formFields: number;
  inputElements: number;
} {
  const cleaned = stripNoise(html);

  let inputElements = 0;
  let formFields = 0;

  const inputPattern = /<input\b[^>]*>/gi;
  let match = inputPattern.exec(cleaned);
  while (match !== null) {
    inputElements += 1;

    const type = (readAttributes(match[0])['type'] ?? 'text').toLowerCase();
    if (!IGNORED_INPUT_TYPES.has(type)) {
      formFields += 1;
    }

    match = inputPattern.exec(cleaned);
  }

  formFields += (cleaned.match(/<select\b[^>]*>/gi) ?? []).length;
  formFields += (cleaned.match(/<textarea\b[^>]*>/gi) ?? []).length;

  return { formFields, inputElements };
}

/**
 * viewport の指定を見る（足切り「LPがスマートフォン非対応」）。
 *
 * **`width=device-width` か、`initial-scale` の指定を求める。**
 * `width=1024` のような固定幅は、指定があってもスマートフォン向けでは
 * ないため `false` にする。
 */
export function detectMobileReady(html: string): boolean {
  const cleaned = stripNoise(html);
  const metaPattern = /<meta\b[^>]*>/gi;

  let match = metaPattern.exec(cleaned);
  while (match !== null) {
    const attributes = readAttributes(match[0]);

    if ((attributes['name'] ?? '').toLowerCase() === 'viewport') {
      const content = (attributes['content'] ?? '').toLowerCase();

      if (content.includes('width=device-width')) {
        return true;
      }

      // `initial-scale` だけの指定も端末幅に追随する
      if (/initial-scale\s*=\s*1(\.0+)?/.test(content)) {
        return true;
      }

      return false;
    }

    match = metaPattern.exec(cleaned);
  }

  return false;
}

/** 取得したHTMLから判定する（ネットワークを触らない） */
export function evaluateHtml(html: string, finalUrl: string): LpEvaluation {
  const { formFields, inputElements } = countFormFields(html);

  return {
    formFields,
    inputElements,
    mobileReady: detectMobileReady(html),
    contentLength: Buffer.byteLength(html, 'utf8'),
    finalUrl,
  };
}

export interface EvaluateLandingPageOptions {
  landingPageUrl: string;
  /** 差し替え用。既定は `safeFetch`（C-7） */
  fetchFn?: typeof safeFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * LPを取得して判定する。
 *
 * @throws {AppError} 到達できない・HTMLでない・エラー応答
 */
export async function evaluateLandingPage(
  options: EvaluateLandingPageOptions,
): Promise<LpEvaluation> {
  const fetchFn = options.fetchFn ?? safeFetch;

  let response;
  try {
    response = await fetchFn(options.landingPageUrl, {
      method: 'GET',
      timeoutMs: options.timeoutMs ?? LP_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? LP_MAX_BYTES,
      allowedContentTypes: LP_CONTENT_TYPES,
    });
  } catch (error) {
    throw toLpError(error);
  }

  if (response.status >= 400) {
    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnavailable,
      `LPを取得できませんでした（HTTP ${response.status}）`,
    );
  }

  return evaluateHtml(response.body, response.finalUrl);
}

/**
 * 取得の失敗を写す。
 *
 * **到達できない理由を細かく返さない**（C-2・C-3・C-5 と同じ方針、SPEC 14.3）。
 * 到達禁止アドレスと接続失敗を区別すると、応答の違いで内部の構成を調べられる。
 */
function toLpError(error: unknown): never {
  if (isHttpFetchError(error)) {
    if (error.code === HTTP_ERROR_CODES.unexpectedContentType) {
      throw lpFetchFailedError(
        LP_ERROR_CODES.lpNotHtml,
        'LPのURLがHTMLを返しませんでした',
        error,
      );
    }

    throw lpFetchFailedError(
      LP_ERROR_CODES.lpUnreachable,
      'LPへ接続できませんでした',
      error,
    );
  }

  throw lpFetchFailedError(
    LP_ERROR_CODES.lpUnavailable,
    'LPを評価できませんでした',
    error,
  );
}
