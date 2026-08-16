/**
 * 案件カタログの画面が使う入口（Q-055）。
 *
 * **画面から `fetch` を直に書かない**（`rich-menu-api` と同じ）。
 */

export type ConversionType =
  'FREE_SIGNUP' | 'REQUEST' | 'TRIAL' | 'PURCHASE' | 'OTHER';

export type LinkMode = 'DIRECT' | 'REDIRECT';

export type CatalogStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';

export interface CatalogItemJson {
  id: string;
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  facts: string[];
  factsUpdatedAt: string | null;
  denyConditions: string[];
  linkMode: LinkMode;
  subIdParam: string | null;
  blogPostingProhibited: boolean;
  lpFormFields: number | null;
  lpMobileReady: boolean | null;
  genreHints: string[];
  notes: string | null;
  status: CatalogStatus;
  updatedAt: string;
}

export interface CatalogItemInputJson {
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  facts: string[];
  denyConditions: string[];
  linkMode: LinkMode;
  subIdParam: string | null;
  blogPostingProhibited: boolean;
  genreHints: string[];
  notes: string | null;
  status: CatalogStatus;
}

export class CatalogApiError extends Error {
  override readonly name = 'CatalogApiError';

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE = '/api/admin/offer-catalog';

async function request<T>(input: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    throw new CatalogApiError(0, 'うまくいきませんでした');
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    throw new CatalogApiError(
      response.status,
      typeof body['message'] === 'string'
        ? body['message']
        : 'うまくいきませんでした',
    );
  }

  return body as T;
}

export function fetchCatalog(): Promise<{ items: CatalogItemJson[] }> {
  return request(BASE);
}

export function createCatalogItem(
  input: CatalogItemInputJson,
): Promise<{ item: CatalogItemJson }> {
  return request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateCatalogItem(
  itemId: string,
  input: CatalogItemInputJson,
): Promise<{ item: CatalogItemJson }> {
  return request(`${BASE}/${itemId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** LPから読み取った下書き（Q-053 の仕組みを使い回す）。**保存されていない** */
export interface CatalogDraftJson {
  name: string;
  conversionType: ConversionType;
  facts: string[];
}

/**
 * 紹介先のページを読んで下書きをもらう。
 *
 * **ASPの名前と報酬額は返らない。** LPに無いため。
 */
export function draftCatalogItem(
  landingPageUrl: string,
): Promise<{ draft: CatalogDraftJson }> {
  return request(`${BASE}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ landingPageUrl }),
  });
}
