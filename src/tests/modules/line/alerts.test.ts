import { describe, expect, it } from 'vitest';
import { alertIdempotencyKey, judgeConnectionAlert } from '@/modules/line';
import { judgeLinkHealth } from '@/modules/affiliate';

/**
 * 緊急通知の判定（TASKS H-3、SPEC 8.3）。
 *
 * 完了条件は「接続切れ・リンク切れ・案件終了が緊急通知される」。
 */

describe('WordPress の接続切れ', () => {
  it('接続済みなら知らせない', () => {
    expect(
      judgeConnectionAlert({
        connectionStatus: 'CONNECTED',
        lastTestedAt: new Date(),
      }),
    ).toBeNull();
  });

  it('切れていれば知らせる', () => {
    expect(
      judgeConnectionAlert({
        connectionStatus: 'FAILED',
        lastTestedAt: new Date(),
      }),
    ).toContain('投稿できません');
  });

  /** **準備中のブログに毎日「接続が切れています」と送らない** */
  it('一度も試していないブログは対象外', () => {
    expect(
      judgeConnectionAlert({ connectionStatus: 'FAILED', lastTestedAt: null }),
    ).toBeNull();
  });

  it('接続そのものが無ければ対象外', () => {
    expect(judgeConnectionAlert(null)).toBeNull();
  });
});

describe('リンクの状態', () => {
  /** **恒久的に消えたものだけを通知する** */
  it.each([[404], [410]])('%d は消えた扱い', (status) => {
    expect(judgeLinkHealth(status)).toBe('GONE');
  });

  it.each([[200], [301], [302]])('%d は生きている', (status) => {
    expect(judgeLinkHealth(status)).toBe('OK');
  });

  /**
   * **ASPのメンテナンスのたびに緊急通知を飛ばさない。**
   * 401・403 は機械的なアクセスを弾いているだけのことが多い
   */
  it.each([[401], [403], [429], [500], [503]])(
    '%d は一時的な失敗',
    (status) => {
      expect(judgeLinkHealth(status)).toBe('UNAVAILABLE');
    },
  );
});

describe('通知の冪等キー（C-4）', () => {
  const alert = {
    blogId: 'blog-1',
    blogName: 'ブログ',
    kind: 'LINK_BROKEN' as const,
    detail: 'x',
  };

  it('種類で始まる', () => {
    const key = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(key.startsWith('LINE_NOTIFY:')).toBe(true);
  });

  it('同じ日の同じ指摘は同じキー', () => {
    const morning = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    const evening = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T13:00:00.000Z'),
    });

    expect(morning).toBe(evening);
  });

  /** **直っていなければ翌日また届く。** 直すまで思い出させる */
  it('日が変われば別のキー', () => {
    const today = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    const tomorrow = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });

    expect(today).not.toBe(tomorrow);
  });

  /**
   * **JSTの日付で区切る。** UTCだと日本の1日が2日にまたがり、
   * 夜の指摘と翌朝の指摘が別扱いになる
   */
  it('JSTの同じ日なら同じキー', () => {
    // JST 2026-08-10 09:00 と 23:00
    const morning = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    const night = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T14:00:00.000Z'),
    });

    expect(morning).toBe(night);
  });

  it('ブログが違えば別のキー', () => {
    const first = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    const second = alertIdempotencyKey({
      alert: { ...alert, blogId: 'blog-2' },
      now: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(first).not.toBe(second);
  });

  it('種類が違えば別のキー', () => {
    const first = alertIdempotencyKey({
      alert,
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    const second = alertIdempotencyKey({
      alert: { ...alert, kind: 'OFFER_ENDED' },
      now: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(first).not.toBe(second);
  });
});
