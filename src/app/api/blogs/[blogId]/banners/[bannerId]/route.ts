import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  BANNER_NAME_MAX_LENGTH,
  BANNER_SLOTS,
  BANNER_URL_MAX_LENGTH,
  TARGET_CATEGORIES_MAX,
  TARGET_CATEGORY_MAX_LENGTH,
  endBannerForUser,
  requireBannerForUser,
  updateBannerForUser,
} from '@/modules/banners';

/**
 * `GET|PATCH|DELETE /api/blogs/:blogId/banners/:bannerId`（SPEC 13.5、TASKS I-3）
 *
 * **ブログ配下に置く**（案件と同じ理由）。`banners.id` は全ブログで
 * 一意なので、IDだけで引くと他ブログのバナーが取れる（SPEC 14.1）。
 *
 * **削除は物理削除しない。** 記事に埋め込んだバナーが残っており、
 * クリックの集計も過去分を参照する。`ENDED` にする（D-3）。
 */

export const runtime = 'nodejs';

/** **`ENDED` を含めない。** 終了は `DELETE` の仕事（案件と同じ） */
const UPDATABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

const updateSchema = z.object({
  name: z.string().min(1).max(BANNER_NAME_MAX_LENGTH).optional(),
  imageUrl: z.string().min(1).max(BANNER_URL_MAX_LENGTH).optional(),
  destinationUrl: z.string().min(1).max(BANNER_URL_MAX_LENGTH).optional(),
  affiliateOfferId: z.string().uuid().nullable().optional(),
  slot: z.enum(BANNER_SLOTS as unknown as [string, ...string[]]).optional(),
  targetCategories: z
    .array(z.string().max(TARGET_CATEGORY_MAX_LENGTH))
    .max(TARGET_CATEGORIES_MAX)
    .optional(),
  status: z.enum(UPDATABLE_STATUSES).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

type Context = { params: Promise<{ blogId: string; bannerId: string }> };

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  return new Date(value);
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId, bannerId } = await context.params;

    const banner = await requireBannerForUser({
      userId: user.id,
      blogId,
      bannerId,
    });

    return Response.json({ banner });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId, bannerId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('バナーの内容を確認してください');
    }

    const input = parsed.data;

    const banner = await updateBannerForUser(
      { userId: user.id, blogId, bannerId },
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
        ...(input.destinationUrl === undefined
          ? {}
          : { destinationUrl: input.destinationUrl }),
        ...(input.affiliateOfferId === undefined
          ? {}
          : { affiliateOfferId: input.affiliateOfferId }),
        ...(input.slot === undefined
          ? {}
          : { slot: input.slot as (typeof BANNER_SLOTS)[number] }),
        ...(input.targetCategories === undefined
          ? {}
          : { targetCategories: input.targetCategories }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsAt === undefined
          ? {}
          : { startsAt: toDate(input.startsAt) }),
        ...(input.endsAt === undefined ? {} : { endsAt: toDate(input.endsAt) }),
      },
    );

    return Response.json({ banner });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId, bannerId } = await context.params;

    // **物理削除しない。** 記事に埋め込んだバナーが残っている（D-3）
    const banner = await endBannerForUser({
      userId: user.id,
      blogId,
      bannerId,
    });

    return Response.json({ banner });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
