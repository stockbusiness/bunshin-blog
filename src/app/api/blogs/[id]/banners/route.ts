import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  BANNER_NAME_MAX_LENGTH,
  BANNER_SLOTS,
  BANNER_URL_MAX_LENGTH,
  TARGET_CATEGORIES_MAX,
  TARGET_CATEGORY_MAX_LENGTH,
  createBannerForUser,
  listBannersForUser,
} from '@/modules/banners';

/**
 * `GET|POST /api/blogs/:id/banners`（SPEC 13.5、TASKS I-3）
 *
 * **D-3 でモジュールは作ったが、HTTPの入口が無かった**（棚卸し・2026-08-12）。
 *
 * 他人のブログは **404**（B-3 の方針）。
 */

export const runtime = 'nodejs';

const createSchema = z.object({
  name: z.string().min(1).max(BANNER_NAME_MAX_LENGTH),
  imageUrl: z.string().min(1).max(BANNER_URL_MAX_LENGTH),
  destinationUrl: z.string().min(1).max(BANNER_URL_MAX_LENGTH),
  // **案件に紐づけなくてよい。** 自社告知のようなバナーもある（D-3）
  affiliateOfferId: z.string().uuid().optional(),
  slot: z.enum(BANNER_SLOTS as unknown as [string, ...string[]]),
  targetCategories: z
    .array(z.string().max(TARGET_CATEGORY_MAX_LENGTH))
    .max(TARGET_CATEGORIES_MAX)
    .optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;

    const banners = await listBannersForUser({ userId: user.id, blogId: id });

    return Response.json({ banners });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('バナーの内容を確認してください');
    }

    const input = parsed.data;

    const banner = await createBannerForUser(
      { userId: user.id, blogId: id },
      {
        name: input.name,
        imageUrl: input.imageUrl,
        destinationUrl: input.destinationUrl,
        slot: input.slot as (typeof BANNER_SLOTS)[number],
        ...(input.affiliateOfferId === undefined
          ? {}
          : { affiliateOfferId: input.affiliateOfferId }),
        ...(input.targetCategories === undefined
          ? {}
          : { targetCategories: input.targetCategories }),
        ...(input.startsAt === undefined
          ? {}
          : { startsAt: new Date(input.startsAt) }),
        ...(input.endsAt === undefined
          ? {}
          : { endsAt: new Date(input.endsAt) }),
      },
    );

    return Response.json({ banner }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
