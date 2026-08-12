import { describe, expect, it } from 'vitest';
import { REPLY_TEXT_MAX_LENGTH, parseLineWebhook } from '@/modules/line';

/**
 * LINE Webhook の電文の読み取り（TASKS D-7b）。
 *
 * **1件が壊れていても全部を落とさない。** LINE は 200 以外を返すと
 * 同じ電文を再送するので、落とすと同じものが延々と届く。
 */

function textEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    webhookEventId: 'ev-1',
    timestamp: Date.UTC(2026, 7, 12, 0, 0, 0),
    source: { type: 'user', userId: 'U-1' },
    replyToken: 'reply-token',
    message: { type: 'text', id: 'm-1', text: '使ってみました' },
    ...overrides,
  };
}

describe('テキストの返信', () => {
  it('読める', () => {
    const parsed = parseLineWebhook({ events: [textEvent()] });

    expect(parsed.skipped).toBe(0);
    expect(parsed.replies).toEqual([
      {
        webhookEventId: 'ev-1',
        lineUserId: 'U-1',
        text: '使ってみました',
        timestamp: new Date(Date.UTC(2026, 7, 12, 0, 0, 0)),
      },
    ]);
  });

  /**
   * **返信トークンは読まない。** 1分ほどで切れるので、ジョブに載せた頃には
   * 使えない。案内は push で送る
   */
  it('返信トークンを持ち出さない', () => {
    const parsed = parseLineWebhook({ events: [textEvent()] });

    expect(JSON.stringify(parsed.replies)).not.toContain('reply-token');
  });
});

/** 友だち追加・スタンプ・画像・既読も同じ入口に届く */
describe('扱わない種類', () => {
  it.each([
    { name: '友だち追加', event: { type: 'follow', webhookEventId: 'ev-2' } },
    {
      name: 'スタンプ',
      event: textEvent({ message: { type: 'sticker', id: 's-1' } }),
    },
    {
      name: 'postback（見送りは F-6）',
      event: { type: 'postback', webhookEventId: 'ev-3' },
    },
  ])('$name は落として数える', ({ event }) => {
    const parsed = parseLineWebhook({ events: [event] });

    expect(parsed.replies).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });
});

describe('壊れた電文', () => {
  it.each([
    { name: 'ユーザーIDが無い', event: textEvent({ source: {} }) },
    { name: '識別子が無い', event: textEvent({ webhookEventId: undefined }) },
    {
      name: '本文が空',
      event: textEvent({ message: { type: 'text', text: '' } }),
    },
    { name: 'そもそも物ではない', event: 'ng' },
  ])('$name は落として数える', ({ event }) => {
    const parsed = parseLineWebhook({ events: [event] });

    expect(parsed.replies).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });

  /** **1件のせいで残りを捨てない。** 捨てると、その電文ごと再送される */
  it('壊れた1件があっても、他は通る', () => {
    const parsed = parseLineWebhook({
      events: [{ type: 'follow' }, textEvent(), 'ng'],
    });

    expect(parsed.replies).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
  });

  it.each([
    { name: '本文が物ではない', body: 'ng' },
    { name: 'events が無い', body: {} },
    { name: 'events が配列ではない', body: { events: 'ng' } },
  ])('$name なら空を返す（例外にしない）', ({ body }) => {
    expect(parseLineWebhook(body)).toEqual({ replies: [], skipped: 0 });
  });
});

/**
 * **長すぎる返信は切らずに落とす。** 途中で切った文を事実として保存すると、
 * 書き手の言っていないことが記憶に残る
 */
describe('長さ', () => {
  it('上限ちょうどは通る', () => {
    const text = 'あ'.repeat(REPLY_TEXT_MAX_LENGTH);
    const parsed = parseLineWebhook({
      events: [textEvent({ message: { type: 'text', text } })],
    });

    expect(parsed.replies[0]?.text).toHaveLength(REPLY_TEXT_MAX_LENGTH);
  });

  it('上限を超えたら落とす', () => {
    const text = 'あ'.repeat(REPLY_TEXT_MAX_LENGTH + 1);
    const parsed = parseLineWebhook({
      events: [textEvent({ message: { type: 'text', text } })],
    });

    expect(parsed.replies).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });
});

/** **時刻が読めなくても落とさない。** 返信そのものは届いている */
describe('時刻', () => {
  it('数値でなければ 1970-01-01 にして残す', () => {
    const parsed = parseLineWebhook({
      events: [textEvent({ timestamp: 'ng' })],
    });

    expect(parsed.replies).toHaveLength(1);
    expect(parsed.replies[0]?.timestamp).toEqual(new Date(0));
  });
});
