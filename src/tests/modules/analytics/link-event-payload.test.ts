import { describe, expect, it } from 'vitest';
import {
  MAX_AGE_MS,
  MAX_EVENTS_PER_REQUEST,
  MAX_FUTURE_MS,
  parseLinkEvents,
} from '@/modules/analytics';

/**
 * 受信APIの電文の検証（TASKS D-12）。
 *
 * **壊れた1件で全部を落とさない。** 送信元は失敗した分を再送するので、
 * 1件のせいで 400 を返すと**同じ電文が延々と送られ続ける。**
 */

const NOW = new Date('2026-08-12T03:00:00.000Z');

function event(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: 'a1b2c3d4-0000-4000-8000-000000000001',
    code: 'abcdefghijklmnopqrstuv',
    clickedAt: '2026-08-12T02:59:00.000Z',
    referrerHost: 'example.com',
    userAgentHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('通るもの', () => {
  it('全項目が揃っていれば通る', () => {
    const result = parseLinkEvents({ events: [event()] }, NOW);

    expect(result.rejected).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: 'a1b2c3d4-0000-4000-8000-000000000001',
      code: 'abcdefghijklmnopqrstuv',
      referrerHost: 'example.com',
    });
    expect(result.events[0]?.clickedAt.toISOString()).toBe(
      '2026-08-12T02:59:00.000Z',
    );
  });

  /** `Referer` は付かないことがある（SPEC 11.4）。欠落は異常ではない */
  it('参照元とUAが無くても通る', () => {
    const result = parseLinkEvents(
      { events: [event({ referrerHost: null, userAgentHash: null })] },
      NOW,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.referrerHost).toBeNull();
    expect(result.events[0]?.userAgentHash).toBeNull();
  });

  it('ホスト名は小文字に揃える', () => {
    const result = parseLinkEvents(
      { events: [event({ referrerHost: 'Example.COM' })] },
      NOW,
    );

    expect(result.events[0]?.referrerHost).toBe('example.com');
  });
});

describe('落とすもの', () => {
  it.each([
    { name: '識別子が無い', patch: { eventId: undefined } },
    { name: '識別子が空', patch: { eventId: '  ' } },
    { name: '識別子に記号が入る', patch: { eventId: 'a b/c' } },
    { name: '識別子が長すぎる', patch: { eventId: 'a'.repeat(65) } },
    { name: 'コードが無い', patch: { code: '' } },
    { name: '時刻が無い', patch: { clickedAt: undefined } },
    { name: '時刻が壊れている', patch: { clickedAt: 'きのう' } },
  ])('$name は落とす', ({ patch }) => {
    const result = parseLinkEvents({ events: [event(patch)] }, NOW);

    expect(result.events).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });

  /**
   * **未来は受けない。** 送信元の時計がずれていても、
   * 集計（G-6）が存在しない日に数を積まないようにする
   */
  it('未来の時刻は落とす', () => {
    const future = new Date(NOW.getTime() + MAX_FUTURE_MS + 1000).toISOString();

    expect(
      parseLinkEvents({ events: [event({ clickedAt: future })] }, NOW).events,
    ).toHaveLength(0);
  });

  it('古すぎる時刻は落とす', () => {
    const old = new Date(NOW.getTime() - MAX_AGE_MS - 1000).toISOString();

    expect(
      parseLinkEvents({ events: [event({ clickedAt: old })] }, NOW).events,
    ).toHaveLength(0);
  });

  /** 少しの未来は通す（送信元と受信側の時計は完全には合わない） */
  it('少しだけ未来なら通す', () => {
    const soon = new Date(NOW.getTime() + 1000).toISOString();

    expect(
      parseLinkEvents({ events: [event({ clickedAt: soon })] }, NOW).events,
    ).toHaveLength(1);
  });
});

/**
 * **生の値を保存させない**（`link_clicks` に戻せる値を残さない）。
 * 形が違うものは落とすのではなく `null` にする — クリックそのものは
 * 実際に起きているので、数から消さない
 */
describe('個人に近い値', () => {
  it('UAのハッシュでない文字列は null にする', () => {
    const result = parseLinkEvents(
      {
        events: [
          event({ userAgentHash: 'Mozilla/5.0 (iPhone; CPU iPhone OS)' }),
        ],
      },
      NOW,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.userAgentHash).toBeNull();
  });

  it('ホスト名でない文字列は null にする', () => {
    const result = parseLinkEvents(
      { events: [event({ referrerHost: 'https://example.com/a?q=1' })] },
      NOW,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.referrerHost).toBeNull();
  });
});

describe('件数', () => {
  /** **同じ電文の中の重複を先に落とす。** DBの unique に任せると
   * `createMany` が丸ごと失敗する */
  it('同じ識別子は1件だけにする', () => {
    const result = parseLinkEvents({ events: [event(), event()] }, NOW);

    expect(result.events).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('上限を超えた分は落とす', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 10 }, (_, i) =>
      event({ eventId: `evt-${String(i)}` }),
    );

    const result = parseLinkEvents({ events }, NOW);

    expect(result.events).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(result.rejected).toBe(10);
  });

  /** **通るものは通す。** 壊れた1件で全部を落とさない */
  it('壊れた1件があっても残りは通る', () => {
    const result = parseLinkEvents(
      {
        events: [
          event({ eventId: 'ok-1' }),
          event({ eventId: 'ng', clickedAt: 'きのう' }),
          event({ eventId: 'ok-2' }),
        ],
      },
      NOW,
    );

    expect(result.events.map((e) => e.eventId)).toEqual(['ok-1', 'ok-2']);
    expect(result.rejected).toBe(1);
  });
});

describe('形が違う本体', () => {
  it.each([[null], [undefined], ['events'], [{ events: 'x' }], [{}]])(
    '%o は空で返す',
    (body) => {
      expect(parseLinkEvents(body, NOW)).toEqual({ events: [], rejected: 0 });
    },
  );
});
