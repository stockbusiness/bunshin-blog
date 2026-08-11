/**
 * Search Analytics API（TASKS G-2、SPEC 11.3）。
 *
 * 完了条件は「日次で表示回数・クリック・順位を保存。**API上限を考慮**」。
 *
 * ## 上限として効くのは行数
 *
 * 1回の問い合わせで返る行は**最大25,000行**で、それ以上は `startRow` で
 * 続きを取る。**返ってきた行数が上限に満たなければそこで終わり**である。
 * 打ち切ると、その日のデータが黙って欠ける。
 *
 * 呼び出し回数の上限（プロパティごとの毎分・1日）もあるが、
 * **30ブログを1日1回では届かない。** 効くのは行数のほうで、
 * ここではそちらを扱う。呼び出しを詰まらせないよう、
 * **ブログをまたぐ処理は直列にする**（呼び出し側の判断）。
 */

import { logger } from '@/lib/logger';
import type { GoogleAccessToken } from './types';
import { SEARCH_CONSOLE_API_BASE } from './search-console';

/** 1回の問い合わせで返る行の上限（Google の仕様） */
export const SEARCH_ANALYTICS_MAX_ROWS = 25_000;

/**
 * 続きを取る回数の上限。
 *
 * **無限に回さないための歯止め**であって、業務上の上限ではない。
 * 25,000 × 20 = 50万行で、Phase 0 の規模（30ブログ）では届かない。
 * ここに達したら**黙って打ち切らず記録する。**
 */
export const SEARCH_ANALYTICS_MAX_PAGES = 20;

export interface SearchAnalyticsRow {
  /** 要求した次元の値。順序は `dimensions` と同じ */
  keys: readonly string[];
  clicks: number;
  impressions: number;
  /**
   * 平均掲載順位。
   *
   * **加重平均であり、行をまたいで足したり平均したりできない。**
   * 合計が要るときは、次元を減らしてGoogleに集計させる。
   */
  position: number;
}

export interface SearchAnalyticsQuery {
  propertyUrl: string;
  /** `YYYY-MM-DD`。Search Console が返す暦日そのまま（Q-005） */
  startDate: string;
  endDate: string;
  dimensions: readonly string[];
}

/**
 * 取得に失敗したことを表す。
 *
 * **やり直して直るかを持つ。** 上限に当たった・Googleが落ちていたなら
 * 時間をおけば直るが、権限が無いなら何度やっても同じで、
 * **再試行はモニターに何も知らせないまま回数を消費する。**
 */
export class SearchAnalyticsError extends Error {
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(params: {
    message: string;
    retryable: boolean;
    httpStatus: number | null;
  }) {
    super(params.message);
    this.name = 'SearchAnalyticsError';
    this.retryable = params.retryable;
    this.httpStatus = params.httpStatus;
  }
}

export interface SearchAnalyticsClient {
  query(input: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]>;
}

export interface CreateSearchAnalyticsClientOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  /** 試験のために小さくする。既定は Google の上限 */
  rowLimit?: number;
}

function toRow(value: unknown): SearchAnalyticsRow | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const keys = record['keys'];
  const clicks = record['clicks'];
  const impressions = record['impressions'];
  const position = record['position'];

  if (
    !Array.isArray(keys) ||
    !keys.every((key): key is string => typeof key === 'string') ||
    typeof clicks !== 'number' ||
    typeof impressions !== 'number' ||
    typeof position !== 'number'
  ) {
    return null;
  }

  return { keys, clicks, impressions, position };
}

/**
 * 検索の実績を取る。**続きがある限り取り切る。**
 *
 * @throws {SearchAnalyticsError}
 */
export function createSearchAnalyticsClient(
  token: GoogleAccessToken,
  options: CreateSearchAnalyticsClientOptions = {},
): SearchAnalyticsClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? SEARCH_CONSOLE_API_BASE;
  const rowLimit = options.rowLimit ?? SEARCH_ANALYTICS_MAX_ROWS;

  return {
    async query(input: SearchAnalyticsQuery): Promise<SearchAnalyticsRow[]> {
      const url = `${baseUrl}/sites/${encodeURIComponent(
        input.propertyUrl,
      )}/searchAnalytics/query`;

      const collected: SearchAnalyticsRow[] = [];

      for (let page = 0; page < SEARCH_ANALYTICS_MAX_PAGES; page += 1) {
        const rows = await fetchPage({
          fetchFn,
          url,
          token,
          input,
          rowLimit,
          startRow: page * rowLimit,
        });

        collected.push(...rows);

        // **上限に満たなければそこで終わり。** 空の応答を待たない
        if (rows.length < rowLimit) {
          return collected;
        }
      }

      // **黙って打ち切らない。** 欠けたことが後から分かるように残す
      logger.error('Search Analytics の取得が上限に達した', {
        pages: SEARCH_ANALYTICS_MAX_PAGES,
        rowLimit,
        dimensions: input.dimensions.join(','),
      });

      return collected;
    },
  };
}

async function fetchPage(params: {
  fetchFn: typeof fetch;
  url: string;
  token: GoogleAccessToken;
  input: SearchAnalyticsQuery;
  rowLimit: number;
  startRow: number;
}): Promise<SearchAnalyticsRow[]> {
  let response: Response;

  try {
    response = await params.fetchFn(params.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.token.token.expose()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startDate: params.input.startDate,
        endDate: params.input.endDate,
        dimensions: params.input.dimensions,
        rowLimit: params.rowLimit,
        startRow: params.startRow,
      }),
    });
  } catch {
    // **届かなかったのは一時的。** やり直せば直りうる
    throw new SearchAnalyticsError({
      message: 'Search Console へ届きませんでした',
      retryable: true,
      httpStatus: null,
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error('Search Analytics の取得が失敗した', {
      status: response.status,
      detail,
    });

    throw new SearchAnalyticsError({
      message: 'Search Console から取得できませんでした',
      // **429（上限）と5xxはやり直す。403・404 は何度やっても同じ**
      retryable: response.status === 429 || response.status >= 500,
      httpStatus: response.status,
    });
  }

  const body: unknown = await response.json().catch(() => null);

  if (typeof body !== 'object' || body === null) {
    throw new SearchAnalyticsError({
      message: 'Search Console の応答を読めませんでした',
      retryable: false,
      httpStatus: response.status,
    });
  }

  const rows = (body as Record<string, unknown>)['rows'];

  // **`rows` が無いのは「その期間にデータが無い」。** 異常ではない
  if (rows === undefined) {
    return [];
  }

  if (!Array.isArray(rows)) {
    throw new SearchAnalyticsError({
      message: 'Search Console の応答を読めませんでした',
      retryable: false,
      httpStatus: response.status,
    });
  }

  const parsed: SearchAnalyticsRow[] = [];

  for (const row of rows) {
    const value = toRow(row);

    // **読めない行を0として数えない。** 落として記録する
    if (value === null) {
      logger.error('Search Analytics の行を読めなかった', {
        dimensions: params.input.dimensions.join(','),
      });
      continue;
    }

    parsed.push(value);
  }

  return parsed;
}
