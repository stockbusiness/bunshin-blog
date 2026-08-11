/**
 * URL Inspection API（TASKS G-3、SPEC 11.3「URL Inspectionは別ジョブ」）。
 *
 * ## 上限が Search Analytics と違う
 *
 * **1プロパティにつき1日2,000回**という別枠の上限がある。
 * Search Analytics（G-2）は1日数回で済むのに対し、こちらは
 * **記事の本数だけ呼ぶ**ため、上限が実際に効く。
 *
 * 別ジョブにするのはそのためでもある。同じジョブに入れると、
 * **上限に当たったときに、取れていたはずの検索データまで巻き戻る。**
 */

import { logger } from '@/lib/logger';
import type { GoogleAccessToken } from './types';

export const URL_INSPECTION_ENDPOINT =
  'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/** 1プロパティにつき1日に呼べる回数（Google の仕様） */
export const URL_INSPECTION_DAILY_QUOTA = 2_000;

/**
 * インデックスされているか。
 *
 * **「分からない」を持つ。** Google が判断を返さないことがあり、
 * そこを `false` に倒すと**「調べたが載っていない」と区別できなくなる。**
 */
export type IndexVerdict = 'INDEXED' | 'NOT_INDEXED' | 'UNKNOWN';

export interface UrlInspectionResult {
  verdict: IndexVerdict;
  /** Google の説明文（`coverageState`）。そのまま記録には使わない */
  coverageState: string | null;
}

export class UrlInspectionError extends Error {
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(params: {
    message: string;
    retryable: boolean;
    httpStatus: number | null;
  }) {
    super(params.message);
    this.name = 'UrlInspectionError';
    this.retryable = params.retryable;
    this.httpStatus = params.httpStatus;
  }
}

export interface UrlInspectionClient {
  inspect(input: {
    propertyUrl: string;
    pageUrl: string;
  }): Promise<UrlInspectionResult>;
}

export interface CreateUrlInspectionClientOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
}

/**
 * Google の判定を3つに畳む。
 *
 * `PASS` は載っている、`FAIL` は載っていない。
 * **`PARTIAL` と `NEUTRAL` は「分からない」に倒す** —
 * 何が部分的なのかはリッチリザルトなどの話で、
 * 索引の有無を断定する根拠にならない。
 */
export function toIndexVerdict(verdict: unknown): IndexVerdict {
  if (verdict === 'PASS') {
    return 'INDEXED';
  }

  if (verdict === 'FAIL') {
    return 'NOT_INDEXED';
  }

  return 'UNKNOWN';
}

export function createUrlInspectionClient(
  token: GoogleAccessToken,
  options: CreateUrlInspectionClientOptions = {},
): UrlInspectionClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? URL_INSPECTION_ENDPOINT;

  return {
    async inspect(input): Promise<UrlInspectionResult> {
      let response: Response;

      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.token.expose()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            inspectionUrl: input.pageUrl,
            siteUrl: input.propertyUrl,
          }),
        });
      } catch {
        throw new UrlInspectionError({
          message: 'Search Console へ届きませんでした',
          retryable: true,
          httpStatus: null,
        });
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logger.error('URL Inspection が失敗した', {
          status: response.status,
          detail,
        });

        throw new UrlInspectionError({
          message: 'インデックス状況を取得できませんでした',
          // **429（上限）と5xxはやり直す。403 は権限の話で、何度やっても同じ**
          retryable: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
        });
      }

      const body: unknown = await response.json().catch(() => null);
      const status = readIndexStatus(body);

      // **読めない応答を「載っていない」にしない**
      if (status === null) {
        return { verdict: 'UNKNOWN', coverageState: null };
      }

      return status;
    },
  };
}

function readIndexStatus(body: unknown): UrlInspectionResult | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const result = (body as Record<string, unknown>)['inspectionResult'];

  if (typeof result !== 'object' || result === null) {
    return null;
  }

  const indexStatus = (result as Record<string, unknown>)['indexStatusResult'];

  if (typeof indexStatus !== 'object' || indexStatus === null) {
    return null;
  }

  const record = indexStatus as Record<string, unknown>;
  const coverageState = record['coverageState'];

  return {
    verdict: toIndexVerdict(record['verdict']),
    coverageState: typeof coverageState === 'string' ? coverageState : null,
  };
}
