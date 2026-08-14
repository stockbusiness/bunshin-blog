import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { createOfferForUser, listOffersForUser } from '@/modules/affiliate';
import { requireConsentedUser } from '@/modules/auth';

/**
 * `GET|POST /api/blogs/:blogId/offers`（SPEC 13.4、TASKS I-3）
 *
 * **D-1 でモジュールは作ったが、HTTPの入口が無かった。** D-1 の完了条件が
 * 「ブログ別に分離される」までで、画面から呼べることを含んでいなかった
 * （棚卸し・2026-08-12）。**オンボーディング STEP 8（案件登録）が
 * 画面から完了できない**状態だった。
 *
 * ## 受け取らない項目
 *
 * **`linkMode` と `subIdParam` は入力から設定できない**（Q-001・Q-014）。
 * ASPの規約に関わる判断で、**モニターに判断させない。** ADMIN が
 * SQL で設定する。
 *
 * **`blogPostingProhibited` も受け取らない**（Q-019）。同じ理由。
 *
 * **`selectionScore` `scoreBreakdown` も受け取らない。** E-5 の算出値。
 *
 * 他人のブログは **404**（B-3 の方針）。
 */

export const runtime = 'nodejs';

const CONVERSION_TYPES = [
  'FREE_SIGNUP',
  'REQUEST',
  'TRIAL',
  'PURCHASE',
  'OTHER',
] as const;

const USER_EXPERIENCES = ['USED', 'NOT_USED', 'UNKNOWN'] as const;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  aspName: z.string().min(1).max(100),
  advertiserName: z.string().max(200).optional(),
  landingPageUrl: z.string().min(1).max(2_000),
  affiliateUrl: z.string().min(1).max(2_000),
  rewardYen: z.number().int().min(0).optional(),
  conversionType: z.enum(CONVERSION_TYPES),
  // **中身の形は決めない。** 案件ごとに載る事実が違う（SPEC 9.6）
  facts: z.unknown().optional(),
  userExperience: z.enum(USER_EXPERIENCES).optional(),
  userRating: z.number().int().min(1).max(5).optional(),
  denyConditions: z.array(z.string().max(500)).max(50).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

type Context = { params: Promise<{ blogId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const { blogId } = await context.params;

    const offers = await listOffersForUser({ userId: user.id, blogId });

    return Response.json({ offers });
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
    const { blogId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('案件の内容を確認してください');
    }

    const input = parsed.data;

    const offer = await createOfferForUser(
      { userId: user.id, blogId },
      {
        name: input.name,
        aspName: input.aspName,
        landingPageUrl: input.landingPageUrl,
        affiliateUrl: input.affiliateUrl,
        conversionType: input.conversionType,
        ...(input.advertiserName === undefined
          ? {}
          : { advertiserName: input.advertiserName }),
        ...(input.rewardYen === undefined
          ? {}
          : { rewardYen: input.rewardYen }),
        ...(input.facts === undefined ? {} : { facts: input.facts }),
        ...(input.userExperience === undefined
          ? {}
          : { userExperience: input.userExperience }),
        ...(input.userRating === undefined
          ? {}
          : { userRating: input.userRating }),
        ...(input.denyConditions === undefined
          ? {}
          : { denyConditions: input.denyConditions }),
        ...(input.startsAt === undefined
          ? {}
          : { startsAt: new Date(input.startsAt) }),
        ...(input.endsAt === undefined
          ? {}
          : { endsAt: new Date(input.endsAt) }),
      },
    );

    return Response.json({ offer }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
