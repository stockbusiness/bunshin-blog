import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readLineChannelSecret, verifyLineSignature } from '@/lib/line';

/**
 * LINE Webhook の署名検証（TASKS D-7b、SPEC 14.3）。
 *
 * **署名を確かめないと、他人になりすまして分身の記憶を書き込める。**
 */

const SECRET = 'channel-secret-0123456789abcdef';
const BODY = '{"events":[{"type":"message"}]}';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('署名', () => {
  it('正しい署名は通る', () => {
    expect(
      verifyLineSignature({
        body: BODY,
        signature: sign(BODY),
        channelSecret: SECRET,
      }),
    ).toBe(true);
  });

  it('本文が1文字でも違えば通らない', () => {
    expect(
      verifyLineSignature({
        body: `${BODY} `,
        signature: sign(BODY),
        channelSecret: SECRET,
      }),
    ).toBe(false);
  });

  it('別の鍵で作った署名は通らない', () => {
    expect(
      verifyLineSignature({
        body: BODY,
        signature: sign(BODY, 'another-secret-0123456789abcdef'),
        channelSecret: SECRET,
      }),
    ).toBe(false);
  });

  /** **設定が無いまま素通りさせない。** 誰でも書き込める状態になる */
  it.each([
    { name: '署名が無い', signature: null, secret: SECRET },
    { name: '署名が空', signature: '', secret: SECRET },
    { name: '鍵が空', signature: sign(BODY), secret: '' },
  ])('$name なら通らない', ({ signature, secret }) => {
    expect(
      verifyLineSignature({ body: BODY, signature, channelSecret: secret }),
    ).toBe(false);
  });

  /** `timingSafeEqual` は長さが違うと例外を投げる。先に見ていないと落ちる */
  it('長さの違う署名で例外にならない', () => {
    expect(() =>
      verifyLineSignature({
        body: BODY,
        signature: 'AAAA',
        channelSecret: SECRET,
      }),
    ).not.toThrow();
  });

  it('base64 でない文字列でも例外にならない', () => {
    expect(() =>
      verifyLineSignature({
        body: BODY,
        signature: '###',
        channelSecret: SECRET,
      }),
    ).not.toThrow();
  });
});

describe('設定の読み取り', () => {
  it('あれば読める', () => {
    const result = readLineChannelSecret({ LINE_CHANNEL_SECRET: SECRET });

    expect(result).toEqual({ ok: true, channelSecret: SECRET });
  });

  /** **足りない変数名だけを返す。値は返さない**（SPEC 14.2） */
  it.each([
    { name: '未設定', env: {} },
    { name: '空白だけ', env: { LINE_CHANNEL_SECRET: '   ' } },
  ])('$name なら足りない名前を返す', ({ env }) => {
    expect(readLineChannelSecret(env)).toEqual({
      ok: false,
      missing: ['LINE_CHANNEL_SECRET'],
    });
  });
});
