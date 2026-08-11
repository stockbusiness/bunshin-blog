/**
 * Search Console API のうち、G-1 で要るところだけ（SPEC 11.3）。
 *
 * ここでするのは**プロパティが読めるかの確認**だけ。
 * 検索データの取得は G-2、URL Inspection は G-3。
 */

import { logger } from '@/lib/logger';
import type { GoogleAccessToken } from './types';

export const SEARCH_CONSOLE_API_BASE =
  'https://www.googleapis.com/webmasters/v3';

/**
 * Search Console が返す権限の水準。
 *
 * **`siteUnverifiedUser` は「権限が無い」と同じ。** 追加はされたが
 * プロパティの所有確認が済んでいない状態で、データは読めない。
 */
export const PERMISSION_LEVELS = [
  'siteOwner',
  'siteFullUser',
  'siteRestrictedUser',
  'siteUnverifiedUser',
] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return (
    typeof value === 'string' &&
    (PERMISSION_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * 取得できたかどうか。
 *
 * **理由を分ける。** モニターに出す案内が変わる。
 *
 * - `NOT_FOUND`：アドレスを追加してもらえていない／プロパティのURLが違う
 * - `UNVERIFIED`：追加はされたが所有確認が済んでいない
 * - `UNAVAILABLE`：Google側の一時的な失敗。**設定の誤りではない**
 */
export type SiteCheckOutcome =
  | { status: 'OK'; permissionLevel: PermissionLevel }
  | { status: 'NOT_FOUND' }
  | { status: 'UNVERIFIED'; permissionLevel: PermissionLevel }
  | { status: 'UNAVAILABLE'; httpStatus: number | null };

export interface SearchConsoleClient {
  getSite(propertyUrl: string): Promise<SiteCheckOutcome>;
}

export interface CreateSearchConsoleClientOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

/**
 * プロパティを1つ確かめるだけのクライアント。
 *
 * **`propertyUrl` を `fetch` の宛先にしない。** 利用者が入れた値だが、
 * ここでは Google のURLのパスの一部として符号化して渡すだけで、
 * こちらから叩きに行くわけではない（SPEC 14.3 の対象外）。
 */
export function createSearchConsoleClient(
  token: GoogleAccessToken,
  options: CreateSearchConsoleClientOptions = {},
): SearchConsoleClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? SEARCH_CONSOLE_API_BASE;

  return {
    async getSite(propertyUrl: string): Promise<SiteCheckOutcome> {
      const url = `${baseUrl}/sites/${encodeURIComponent(propertyUrl)}`;

      let response: Response;

      try {
        response = await fetchFn(url, {
          headers: { authorization: `Bearer ${token.token.expose()}` },
        });
      } catch {
        // **届かなかったことを「権限が無い」にしない**（H-3 と同じ筋）
        return { status: 'UNAVAILABLE', httpStatus: null };
      }

      if (response.status === 404) {
        return { status: 'NOT_FOUND' };
      }

      // **403 も `NOT_FOUND` と同じに倒す。** Google は「プロパティが無い」と
      // 「こちらが利用者に入っていない」をどちらでも返しうるが、
      // **モニターがすることは同じ**（アドレスを追加する／URLを直す）。
      // `alerts.ts` で未接続と切断を分けなかったのと同じ理由
      if (response.status === 403) {
        return { status: 'NOT_FOUND' };
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logger.error('Search Console のプロパティ確認が失敗した', {
          status: response.status,
          detail,
        });

        return { status: 'UNAVAILABLE', httpStatus: response.status };
      }

      const body: unknown = await response.json().catch(() => null);
      const permissionLevel =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['permissionLevel']
          : undefined;

      if (!isPermissionLevel(permissionLevel)) {
        return { status: 'UNAVAILABLE', httpStatus: response.status };
      }

      if (permissionLevel === 'siteUnverifiedUser') {
        return { status: 'UNVERIFIED', permissionLevel };
      }

      return { status: 'OK', permissionLevel };
    },
  };
}
