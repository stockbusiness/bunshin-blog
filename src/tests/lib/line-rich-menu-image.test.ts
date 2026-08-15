import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  inspectRichMenuImage,
  matchesCanvasAspect,
} from '@/lib/line/rich-menu-image';
import { RICH_MENU_CANVAS } from '@/lib/line/rich-menu';

/**
 * リッチメニューの画像の検査（Q-054）。
 *
 * **LINE に投げれば断られるが、返るのは英語の API エラー**で、
 * 何を直せばよいかを画面に出せない。**上げた直後に日本語で言う。**
 */

/** PNG の頭だけを組む（`IHDR` に縦横が入っている） */
function png(width: number, height: number, padTo = 0): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const bytes = [
    ...head,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    ...uint32(width),
    ...uint32(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
  ];

  return pad(Uint8Array.from(bytes), padTo);
}

/** JPEG の頭だけを組む（`SOF0` に縦横が入っている） */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    // APP0（読み飛ばされることを確かめる）
    0xff,
    0xe0,
    0x00,
    0x10,
    ...new Array<number>(14).fill(0x00),
    // SOF0
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    ...uint16(height),
    ...uint16(width),
    0x03,
  ]);
}

function uint32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function uint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function pad(bytes: Uint8Array, to: number): Uint8Array {
  if (to <= bytes.byteLength) {
    return bytes;
  }

  const out = new Uint8Array(to);
  out.set(bytes);

  return out;
}

describe('大きさを読む', () => {
  it('PNG の縦横を読む', () => {
    const result = inspectRichMenuImage(png(2500, 1686));

    expect(result).toEqual({
      ok: true,
      image: { mimeType: 'image/png', width: 2500, height: 1686 },
    });
  });

  /** **APP0 のような印を読み飛ばして SOF まで進む** */
  it('JPEG の縦横を読む', () => {
    const result = inspectRichMenuImage(jpeg(2500, 843));

    expect(result).toEqual({
      ok: true,
      image: { mimeType: 'image/jpeg', width: 2500, height: 843 },
    });
  });

  it('PNG でも JPEG でもなければ断る', () => {
    const result = inspectRichMenuImage(Uint8Array.from([0x47, 0x49, 0x46]));

    expect(result).toEqual({
      ok: false,
      message: 'PNG か JPEG の画像を選んでください',
    });
  });
});

describe('LINE の決まりで断る', () => {
  /** **1MB を超えると LINE が受け取らない** */
  it('大きすぎる画像を断る', () => {
    const result = inspectRichMenuImage(png(2500, 1686, MAX_IMAGE_BYTES + 1));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('1MB以下');
  });

  it('横が足りない画像を断る', () => {
    const result = inspectRichMenuImage(png(640, 432));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('800');
  });

  it('横が大きすぎる画像を断る', () => {
    const result = inspectRichMenuImage(png(3000, 2024));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('2500');
  });

  it('縦が足りない画像を断る', () => {
    const result = inspectRichMenuImage(png(2500, 200));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('250px 以上');
  });
});

/**
 * **比が違うと、管理画面で見た升目と指で押す場所がずれる。**
 * LINE は画像を枠へ引き伸ばすため。
 */
describe('枠の縦横比と合っているか', () => {
  it('同じ比なら通す（小さい画像でも）', () => {
    expect(
      matchesCanvasAspect({ width: 1200, height: 810 }, RICH_MENU_CANVAS.LARGE),
    ).toBe(true);
  });

  it('ぴったりなら通す', () => {
    expect(
      matchesCanvasAspect(
        { width: 2500, height: 843 },
        RICH_MENU_CANVAS.COMPACT,
      ),
    ).toBe(true);
  });

  it('大きい枠の画像を細い枠へは通さない', () => {
    expect(
      matchesCanvasAspect(
        { width: 2500, height: 1686 },
        RICH_MENU_CANVAS.COMPACT,
      ),
    ).toBe(false);
  });

  it('少しずれた比を断る', () => {
    expect(
      matchesCanvasAspect(
        { width: 2500, height: 1900 },
        RICH_MENU_CANVAS.LARGE,
      ),
    ).toBe(false);
  });
});
