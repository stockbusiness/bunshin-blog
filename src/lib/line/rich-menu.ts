/**
 * LINE Messaging API のリッチメニュー（Q-054）。
 *
 * **SDKを入れず `fetch` で叩く**（`messaging.ts` と同じ判断）。
 *
 * ## 叩くのは5本
 *
 * | | 何をする |
 * |---|---|
 * | `create` | 枠と押す場所を作る。**この時点ではまだ誰にも出ない** |
 * | `uploadImage` | 画像を上げる。**別ホスト**（`api-data.line.me`） |
 * | `setDefault` | 全員に出す |
 * | `list` / `getDefault` | **いま LINE に何があるかを確かめる** |
 * | `remove` | 古いものを片づける |
 *
 * ## 作る順番を守る
 *
 * **画像を上げていないリッチメニューは既定にできない**（LINE が拒む）。
 * `create` → `uploadImage` → `setDefault` の順で、
 * **途中で失敗したら既定を差し替えない。** いま出ているものは壊さない。
 *
 * ## 応答本文を投げない
 *
 * `messaging.ts` と同じ（SPEC 14.2）。理由はログにだけ残す。
 */

import { logger } from '@/lib/logger';
import type { LineConfig } from './messaging';
import { LineSendError } from './types';

export const RICH_MENU_ENDPOINT = 'https://api.line.me/v2/bot/richmenu';
export const RICH_MENU_DATA_ENDPOINT =
  'https://api-data.line.me/v2/bot/richmenu';
export const RICH_MENU_DEFAULT_ENDPOINT =
  'https://api.line.me/v2/bot/user/all/richmenu';

/** LINE が受け付ける枠の大きさ。**この2つだけ** */
export const RICH_MENU_CANVAS = {
  LARGE: { width: 2500, height: 1686 },
  COMPACT: { width: 2500, height: 843 },
} as const;

export type RichMenuCanvasName = keyof typeof RICH_MENU_CANVAS;

/** 押す場所の上限（LINE の仕様） */
export const MAX_RICH_MENU_AREAS = 20;

/** トークルーム下部に出る文字の上限（LINE の仕様） */
export const MAX_CHAT_BAR_TEXT_LENGTH = 14;

/** リッチメニューの名前の上限（LINE の仕様）。管理用で利用者には見えない */
export const MAX_RICH_MENU_NAME_LENGTH = 300;

export interface RichMenuBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RichMenuArea {
  bounds: RichMenuBounds;
  /** 押したときに開くURL。**https のみ**（`definition.ts` が縛る） */
  uri: string;
  /** 読み上げ等に使われる短い名前 */
  label: string;
}

export interface RichMenuDefinition {
  canvas: RichMenuCanvasName;
  name: string;
  chatBarText: string;
  /** 開いた状態で出すか */
  selected: boolean;
  areas: readonly RichMenuArea[];
}

/** LINE 側にいま在るリッチメニュー */
export interface RemoteRichMenu {
  richMenuId: string;
  name: string;
  chatBarText: string;
}

export interface RichMenuClient {
  create(definition: RichMenuDefinition): Promise<string>;
  uploadImage(
    richMenuId: string,
    image: Uint8Array,
    contentType: string,
  ): Promise<void>;
  setDefault(richMenuId: string): Promise<void>;
  /** 既定が無ければ `null` */
  getDefault(): Promise<string | null>;
  list(): Promise<RemoteRichMenu[]>;
  remove(richMenuId: string): Promise<void>;
}

export interface CreateRichMenuClientOptions {
  fetchFn?: typeof fetch;
  /** 試験のために差し替える */
  endpoint?: string;
  dataEndpoint?: string;
  defaultEndpoint?: string;
}

export function createRichMenuClient(
  config: LineConfig,
  options: CreateRichMenuClientOptions = {},
): RichMenuClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? RICH_MENU_ENDPOINT;
  const dataEndpoint = options.dataEndpoint ?? RICH_MENU_DATA_ENDPOINT;
  const defaultEndpoint = options.defaultEndpoint ?? RICH_MENU_DEFAULT_ENDPOINT;

  const authorization = `Bearer ${config.channelAccessToken}`;

  async function send(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Response> {
    let response: Response;

    try {
      response = await fetchFn(url, init);
    } catch (cause) {
      throw new LineSendError(`LINE の${what}に失敗しました`, { cause });
    }

    if (!response.ok) {
      // **応答本文をそのまま投げない**（SPEC 14.2。`messaging.ts` と同じ）
      const detail = await response.text().catch(() => '');
      logger.error('LINE のリッチメニューAPIがエラーを返した', {
        what,
        status: response.status,
        detail,
      });

      throw new LineSendError(`LINE の${what}に失敗しました`);
    }

    return response;
  }

  return {
    async create(definition) {
      const response = await send(
        endpoint,
        {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(toLinePayload(definition)),
        },
        'リッチメニューの作成',
      );

      const body: unknown = await response.json().catch(() => null);
      const richMenuId = readRichMenuId(body);

      if (richMenuId === null) {
        throw new LineSendError('LINE のリッチメニューの作成に失敗しました');
      }

      return richMenuId;
    },

    async uploadImage(richMenuId, image, contentType) {
      await send(
        `${dataEndpoint}/${encodeURIComponent(richMenuId)}/content`,
        {
          method: 'POST',
          headers: { authorization, 'content-type': contentType },
          // `Uint8Array` をそのまま渡す（`Buffer` へ写さない）
          body: image as unknown as BodyInit,
        },
        'リッチメニューの画像の登録',
      );
    },

    async setDefault(richMenuId) {
      await send(
        `${defaultEndpoint}/${encodeURIComponent(richMenuId)}`,
        { method: 'POST', headers: { authorization } },
        'リッチメニューの適用',
      );
    },

    async getDefault() {
      let response: Response;

      try {
        response = await fetchFn(defaultEndpoint, {
          method: 'GET',
          headers: { authorization },
        });
      } catch (cause) {
        throw new LineSendError('LINE のリッチメニューの確認に失敗しました', {
          cause,
        });
      }

      // **既定が無いのは異常ではない。** まだ一度も出していない状態
      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logger.error('LINE のリッチメニューAPIがエラーを返した', {
          what: 'リッチメニューの確認',
          status: response.status,
          detail,
        });

        throw new LineSendError('LINE のリッチメニューの確認に失敗しました');
      }

      const body: unknown = await response.json().catch(() => null);

      return readRichMenuId(body);
    },

    async list() {
      const response = await send(
        `${endpoint}/list`,
        { method: 'GET', headers: { authorization } },
        'リッチメニューの一覧の取得',
      );

      const body: unknown = await response.json().catch(() => null);

      return readRichMenuList(body);
    },

    async remove(richMenuId) {
      await send(
        `${endpoint}/${encodeURIComponent(richMenuId)}`,
        { method: 'DELETE', headers: { authorization } },
        'リッチメニューの削除',
      );
    },
  };
}

/** 保存している形を LINE の形へ写す */
export function toLinePayload(definition: RichMenuDefinition): unknown {
  return {
    size: RICH_MENU_CANVAS[definition.canvas],
    selected: definition.selected,
    name: definition.name,
    chatBarText: definition.chatBarText,
    areas: definition.areas.map((area) => ({
      bounds: area.bounds,
      action: { type: 'uri', label: area.label, uri: area.uri },
    })),
  };
}

function readRichMenuId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const value = (body as { richMenuId?: unknown }).richMenuId;

  return typeof value === 'string' && value !== '' ? value : null;
}

function readRichMenuList(body: unknown): RemoteRichMenu[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }

  const list = (body as { richmenus?: unknown }).richmenus;

  if (!Array.isArray(list)) {
    return [];
  }

  const menus: RemoteRichMenu[] = [];

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const richMenuId = record['richMenuId'];

    if (typeof richMenuId !== 'string' || richMenuId === '') {
      continue;
    }

    menus.push({
      richMenuId,
      name: typeof record['name'] === 'string' ? record['name'] : '',
      chatBarText:
        typeof record['chatBarText'] === 'string' ? record['chatBarText'] : '',
    });
  }

  return menus;
}
