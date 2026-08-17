/**
 * 案件カタログの画面が使う入口（Q-055）。
 *
 * **画面から `fetch` を直に書かない**（`rich-menu-api` と同じ）。
 */

import { readApiErrorMessage } from '@/lib/api-error';

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
      readApiErrorMessage(body, 'うまくいきませんでした'),
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

/** CSVの取り込みで返る候補（Q-056）。**まだ保存されていない** */
export interface ImportCandidateJson {
  rowNumber: number;
  name: string;
  advertiserName: string | null;
  landingPageUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  denyConditions: string[];
  status: string;
  problem: string | null;
}

export interface ImportPreviewJson {
  headers: string[];
  /** 項目 → 列の番号。**人が直せる** */
  mapping: Record<string, number>;
  /** 足切りを通ったもの */
  kept: ImportCandidateJson[];
  /** 落ちた理由ごとの件数。**黙って捨てない** */
  droppedByReason: Record<string, number>;
  totalRows: number;
  droppedRows: number;
}

/**
 * CSVを読んで、足切りを通った候補を返す。**保存しない。**
 *
 * `mapping` を渡さなければ、AIが列の対応を推測する。
 */
export function previewImport(
  csvBase64: string,
  mapping?: Record<string, number>,
): Promise<ImportPreviewJson> {
  return request(`${BASE}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'preview',
      csv: csvBase64,
      ...(mapping === undefined ? {} : { mapping }),
    }),
  });
}

/** 確かめた候補をカタログへ入れる。**下書きとして入る** */
export function registerImported(
  aspName: string,
  items: Omit<ImportCandidateJson, 'rowNumber' | 'problem' | 'status'>[],
): Promise<{ added: number; skipped: number }> {
  return request(`${BASE}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'register', aspName, items }),
  });
}
