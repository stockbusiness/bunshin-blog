/**
 * リッチメニューの画像を検査する（Q-054）。
 *
 * ## なぜ自分で見るのか
 *
 * **LINE に投げれば断られる。** だが返ってくるのは英語の API エラーで、
 * **何を直せばよいかが画面に出せない。** 上げた直後に
 * 「横が足りません」と言えるほうが、直しに行ける。
 *
 * ## 依存を足さない
 *
 * 大きさを知りたいだけなので、**PNG と JPEG の頭だけを読む。**
 * 画像処理の依存を1つ増やす価値が無い（`messaging.ts` と同じ判断）。
 * **中身を描き直すことはしない** — 上げられたものをそのまま LINE へ渡す。
 */

/** LINE の上限。1MB */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/** LINE が受け付ける横幅 */
export const MIN_IMAGE_WIDTH = 800;
export const MAX_IMAGE_WIDTH = 2500;

/** LINE が受け付ける最小の高さ */
export const MIN_IMAGE_HEIGHT = 250;

/**
 * 枠の縦横比とどれだけずれてよいか。
 *
 * **ずれると押す場所が絵とずれる。** LINE は画像を枠へ引き伸ばすので、
 * 比が違うと**管理画面で見た升目と、指で押す場所が食い違う。**
 */
export const ASPECT_TOLERANCE = 0.02;

export type ImageMimeType = 'image/png' | 'image/jpeg';

export interface InspectedImage {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export type InspectImageResult =
  { ok: true; image: InspectedImage } | { ok: false; message: string };

/**
 * 画像の形式と大きさを読む。
 *
 * **読めなかったら断る。** 読めないものを LINE へ渡さない。
 */
export function inspectRichMenuImage(bytes: Uint8Array): InspectImageResult {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: `画像が大きすぎます（${formatBytes(bytes.byteLength)}）。1MB以下にしてください`,
    };
  }

  const size = readPngSize(bytes) ?? readJpegSize(bytes);

  if (size === null) {
    return {
      ok: false,
      message: 'PNG か JPEG の画像を選んでください',
    };
  }

  if (size.width < MIN_IMAGE_WIDTH || size.width > MAX_IMAGE_WIDTH) {
    return {
      ok: false,
      message: `横幅が ${String(size.width)}px です。${String(MIN_IMAGE_WIDTH)}〜${String(MAX_IMAGE_WIDTH)}px にしてください`,
    };
  }

  if (size.height < MIN_IMAGE_HEIGHT) {
    return {
      ok: false,
      message: `高さが ${String(size.height)}px です。${String(MIN_IMAGE_HEIGHT)}px 以上にしてください`,
    };
  }

  return { ok: true, image: size };
}

/**
 * 枠の縦横比と合っているかを見る。
 *
 * **合っていないと、升目と指で押す場所がずれる**（上記）。
 */
export function matchesCanvasAspect(
  image: { width: number; height: number },
  canvas: { width: number; height: number },
): boolean {
  const wanted = canvas.width / canvas.height;
  const actual = image.width / image.height;

  return Math.abs(actual - wanted) / wanted <= ASPECT_TOLERANCE;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG は `IHDR` が必ず先頭にあり、そこに縦横が入っている */
function readPngSize(bytes: Uint8Array): InspectedImage | null {
  if (bytes.byteLength < 24) {
    return null;
  }

  for (const [index, expected] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== expected) {
      return null;
    }
  }

  // 8..11 が長さ、12..15 が `IHDR`、16..19 が横、20..23 が縦
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }

  return {
    mimeType: 'image/png',
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20),
  };
}

/**
 * JPEG は印（マーカー）を辿らないと大きさが分からない。
 *
 * 縦横を持つのは SOF0〜SOF15 のうち、差分符号化でない印だけ。
 */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegSize(bytes: Uint8Array): InspectedImage | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;

  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      // 印の頭が来ないなら、これ以上は追えない
      return null;
    }

    const marker = bytes[offset + 1];

    if (marker === undefined) {
      return null;
    }

    // 詰め物（0xFF の並び）は読み飛ばす
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // 大きさを持たない印
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = readUint16(bytes, offset + 2);

    if (length < 2) {
      return null;
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      // 印・長さ(2)・精度(1) の次が 縦(2)・横(2)
      return {
        mimeType: 'image/jpeg',
        height: readUint16(bytes, offset + 5),
        width: readUint16(bytes, offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)
  );
}

function readUint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(2)}MB`;
}
