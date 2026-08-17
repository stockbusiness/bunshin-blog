/**
 * リッチメニューの画面が使う入口（Q-054）。
 *
 * **画面から `fetch` を直に書かない**（`settings-api` と同じ）。
 * 試験で差し替えられる形にしておく。
 */

import { readApiErrorMessage } from '@/lib/api-error';

export interface AreaJson {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  uri: string;
}

export type CanvasName = 'LARGE' | 'COMPACT';

export interface DestinationJson {
  label: string;
  path: string;
}

export interface RichMenuJson {
  name: string;
  chatBarText: string;
  canvas: CanvasName;
  selected: boolean;
  areas: AreaJson[];
  hasImage: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  lineRichMenuId: string | null;
  appliedAt: string | null;
}

export interface RemoteRichMenuJson {
  richMenuId: string;
  name: string;
  chatBarText: string;
}

export interface RichMenuStateJson {
  remote: RemoteRichMenuJson[];
  defaultRichMenuId: string | null;
  applied: boolean;
}

export interface AppliedJson {
  lineRichMenuId: string;
  /** 片づけそこねた古いメニュー。**黙って隠さない** */
  staleRichMenuId: string | null;
}

export interface LoadedRichMenu {
  richMenu: RichMenuJson;
  /** 行き先を組み立てるのに要る。未設定なら空文字 */
  liffBaseUrl: string;
  destinations: DestinationJson[];
}

/** 画面に出せる形で失敗を運ぶ（`SettingsApiError` と同じ） */
export class RichMenuApiError extends Error {
  override readonly name = 'RichMenuApiError';

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE = '/api/admin/rich-menu';

async function request<T>(input: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    throw new RichMenuApiError(0, 'うまくいきませんでした');
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    throw new RichMenuApiError(
      response.status,
      readApiErrorMessage(body, 'うまくいきませんでした'),
    );
  }

  return body as T;
}

export async function fetchRichMenu(): Promise<LoadedRichMenu> {
  const body = await request<{
    richMenu: RichMenuJson;
    liffBaseUrl?: string;
    destinations?: DestinationJson[];
  }>(BASE);

  return {
    richMenu: body.richMenu,
    liffBaseUrl: body.liffBaseUrl ?? '',
    destinations: body.destinations ?? [],
  };
}

/** **保存するだけ。LINEには出ない** */
export function saveRichMenu(input: {
  name: string;
  chatBarText: string;
  canvas: CanvasName;
  selected: boolean;
  areas: AreaJson[];
}): Promise<{ richMenu: RichMenuJson }> {
  return request(BASE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function uploadRichMenuImage(
  data: ArrayBuffer,
  contentType: string,
): Promise<{ richMenu: RichMenuJson }> {
  return request(`${BASE}/image`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: data,
  });
}

/** **ここで初めてLINEに出る** */
export function applyRichMenu(): Promise<{ applied: AppliedJson }> {
  return request(`${BASE}/apply`, { method: 'POST' });
}

/** **保存した値ではなくLINEに聞く** */
export function fetchRichMenuState(): Promise<{ state: RichMenuStateJson }> {
  return request(`${BASE}/state`);
}

export function removeRemoteRichMenu(
  richMenuId: string,
): Promise<{ removed: string }> {
  return request(`${BASE}/state`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ richMenuId }),
  });
}
