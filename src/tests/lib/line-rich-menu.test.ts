import { describe, expect, it, vi } from 'vitest';
import {
  createRichMenuClient,
  toLinePayload,
  type RichMenuDefinition,
} from '@/lib/line/rich-menu';
import { LineSendError } from '@/lib/line/types';

/**
 * リッチメニューの LINE API（Q-054）。
 *
 * **応答本文を例外へ載せない**（SPEC 14.2。`messaging.ts` と同じ）。
 */

const CONFIG = { channelAccessToken: 'test-token' };

const DEFINITION: RichMenuDefinition = {
  canvas: 'LARGE',
  name: 'BUNSHIN BLOG',
  chatBarText: 'メニュー',
  selected: true,
  areas: [
    {
      bounds: { x: 0, y: 0, width: 1250, height: 843 },
      label: 'はじめの設定',
      uri: 'https://liff.line.me/1-a/liff/onboarding',
    },
  ],
};

/** 最初の呼び出しを型のついた形で取り出す */
function firstCall(fn: { mock: { calls: unknown[][] } }): {
  url: string;
  init: { method?: string; headers?: Record<string, string> };
} {
  const call = fn.mock.calls[0];

  if (call === undefined) {
    throw new Error('fetch が呼ばれていない');
  }

  return {
    url: String(call[0]),
    init: (call[1] ?? {}) as {
      method?: string;
      headers?: Record<string, string>;
    },
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LINE の形へ写す', () => {
  it('枠の大きさは名前から決まる', () => {
    expect(toLinePayload(DEFINITION)).toMatchObject({
      size: { width: 2500, height: 1686 },
      selected: true,
      name: 'BUNSHIN BLOG',
      chatBarText: 'メニュー',
    });
  });

  /** 保存側は `uri` を平らに持ち、LINE は `action` で包む */
  it('押す場所を action で包む', () => {
    const payload = toLinePayload(DEFINITION) as {
      areas: { bounds: unknown; action: unknown }[];
    };

    expect(payload.areas[0]).toEqual({
      bounds: { x: 0, y: 0, width: 1250, height: 843 },
      action: {
        type: 'uri',
        label: 'はじめの設定',
        uri: 'https://liff.line.me/1-a/liff/onboarding',
      },
    });
  });

  it('細い枠は 2500×843 になる', () => {
    const payload = toLinePayload({ ...DEFINITION, canvas: 'COMPACT' });

    expect(payload).toMatchObject({ size: { width: 2500, height: 843 } });
  });
});

describe('作る', () => {
  it('できた ID を返す', async () => {
    const fetchFn = vi.fn(async () => ok({ richMenuId: 'richmenu-1' }));

    const client = createRichMenuClient(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.create(DEFINITION)).resolves.toBe('richmenu-1');

    const { init } = firstCall(fetchFn);

    expect(init.method).toBe('POST');
    expect(init.headers?.['authorization']).toBe('Bearer test-token');
  });

  it('ID が返らなければ失敗にする', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(async () => ok({})) as unknown as typeof fetch,
    });

    await expect(client.create(DEFINITION)).rejects.toBeInstanceOf(
      LineSendError,
    );
  });

  /** **応答本文を例外へ載せない**（SPEC 14.2） */
  it('エラーの中身を例外へ載せない', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(
        async () =>
          new Response('{"message":"secret detail"}', { status: 400 }),
      ) as unknown as typeof fetch,
    });

    await expect(client.create(DEFINITION)).rejects.toThrow(
      /リッチメニューの作成に失敗しました/,
    );
    await expect(client.create(DEFINITION)).rejects.not.toThrow(
      /secret detail/,
    );
  });
});

describe('画像を上げる', () => {
  /** **別ホストへ送る**（`api-data.line.me`）。ここを間違えると 404 になる */
  it('データ用のホストへ、画像の種類のまま送る', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

    const client = createRichMenuClient(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.uploadImage(
      'richmenu-1',
      Uint8Array.from([1, 2, 3]),
      'image/png',
    );

    const { url, init } = firstCall(fetchFn);

    expect(url).toBe(
      'https://api-data.line.me/v2/bot/richmenu/richmenu-1/content',
    );
    expect(init.headers?.['content-type']).toBe('image/png');
  });
});

describe('いま出ているものを確かめる', () => {
  /** **既定が無いのは異常ではない。** まだ一度も出していない状態 */
  it('既定が無ければ null を返す（404 を投げない）', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(
        async () => new Response('{}', { status: 404 }),
      ) as unknown as typeof fetch,
    });

    await expect(client.getDefault()).resolves.toBeNull();
  });

  it('既定の ID を返す', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(async () =>
        ok({ richMenuId: 'richmenu-9' }),
      ) as unknown as typeof fetch,
    });

    await expect(client.getDefault()).resolves.toBe('richmenu-9');
  });

  it('一覧を読む', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(async () =>
        ok({
          richmenus: [
            { richMenuId: 'a', name: '古い', chatBarText: 'メニュー' },
            { richMenuId: 'b', name: '新しい', chatBarText: 'メニュー' },
          ],
        }),
      ) as unknown as typeof fetch,
    });

    await expect(client.list()).resolves.toEqual([
      { richMenuId: 'a', name: '古い', chatBarText: 'メニュー' },
      { richMenuId: 'b', name: '新しい', chatBarText: 'メニュー' },
    ]);
  });

  /** **読めない行で画面を止めない** */
  it('形の違う行は落とす', async () => {
    const client = createRichMenuClient(CONFIG, {
      fetchFn: vi.fn(async () =>
        ok({ richmenus: [{ name: 'IDが無い' }, { richMenuId: 'b' }] }),
      ) as unknown as typeof fetch,
    });

    await expect(client.list()).resolves.toEqual([
      { richMenuId: 'b', name: '', chatBarText: '' },
    ]);
  });
});

describe('消す', () => {
  it('DELETE で消す', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

    const client = createRichMenuClient(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.remove('richmenu-1');

    const { url, init } = firstCall(fetchFn);

    expect(url).toBe('https://api.line.me/v2/bot/richmenu/richmenu-1');
    expect(init.method).toBe('DELETE');
  });
});
