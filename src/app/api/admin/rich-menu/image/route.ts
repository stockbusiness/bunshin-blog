import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { MAX_IMAGE_BYTES } from '@/lib/line';
import { requireAdmin } from '@/modules/auth';
import { readRichMenuImage, saveRichMenuImage } from '@/modules/line';

/**
 * `GET|PUT /api/admin/rich-menu/image`（Q-054）
 *
 * リッチメニューの画像。**ADMIN だけ。**
 *
 * ## 生のバイト列で受ける
 *
 * `multipart/form-data` にしていない。**上げるのは1つだけ**なので、
 * 境界を解く必要が無い。種類は `Content-Type` で受け、
 * **中身から読み直して確かめる**（申告を信じない）。
 *
 * ## GET は管理画面の下見のためだけにある
 *
 * 押す場所を決めるとき、**絵の上に升目を重ねて見せる**のに要る。
 * `ADMIN` を通した上で返す（`no-store`。誰かに配るものではない）。
 */

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    const image = await readRichMenuImage();

    if (image === null) {
      throw AppError.notFound('画像がまだありません');
    }

    return new Response(image.data as unknown as BodyInit, {
      headers: {
        'content-type': image.mimeType,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const admin = await requireAdmin(request.headers.get('cookie'));

    const body = await request.arrayBuffer();

    if (body.byteLength === 0) {
      throw AppError.validationFailed('画像が空です');
    }

    // **先に長さで断る。** 1MBを超えるものを読み進めない
    if (body.byteLength > MAX_IMAGE_BYTES) {
      throw AppError.validationFailed(
        '画像が大きすぎます。1MB以下にしてください',
      );
    }

    const richMenu = await saveRichMenuImage(new Uint8Array(body), admin.id);

    return Response.json({ richMenu });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
