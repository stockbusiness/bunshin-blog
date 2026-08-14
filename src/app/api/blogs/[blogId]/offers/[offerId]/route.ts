import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import {
  endOfferForUser,
  requireOfferForUser,
  updateOfferForUser,
} from '@/modules/affiliate';
import { requireConsentedUser } from '@/modules/auth';

/**
 * `GET|PATCH|DELETE /api/blogs/:blogId/offers/:offerId`（SPEC 13.4、TASKS I-3）
 *
 * **SPEC 13.4 は `/api/offers/:offerId` と書いているが、ブログ配下に置く。**
 * 案件はブログに属し（D-1）、**IDだけで引くと他ブログの案件が取れる**
 * （`affiliate_offers.id` は全ブログで一意）。ブログ配下にすれば、
 * 所有権の確認が経路そのものに現れる（SPEC 14.1）。
 *
 * **削除は物理削除しない。** 記事に埋め込んだリンクが残っており、
 * 成果の紐付け（サブID）も過去分を参照する。`ENDED` にする（D-1）。
 *
 * 他人のブログ・他ブログの案件は **404**。
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

/**
 * **`ENDED` を含めない。** 終了は `DELETE` の仕事で、
 * 状態の更新から終わらせられると「消したつもりが残る」逆も起きる
 */
const UPDATABLE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'NEEDS_REVIEW',
] as const;

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  aspName: z.string().min(1).max(100).optional(),
  advertiserName: z.string().max(200).nullable().optional(),
  landingPageUrl: z.string().min(1).max(2_000).optional(),
  affiliateUrl: z.string().min(1).max(2_000).optional(),
  rewardYen: z.number().int().min(0).nullable().optional(),
  conversionType: z.enum(CONVERSION_TYPES).optional(),
  facts: z.unknown().optional(),
  userExperience: z.enum(USER_EXPERIENCES).optional(),
  userRating: z.number().int().min(1).max(5).nullable().optional(),
  denyConditions: z.array(z.string().max(500)).max(50).optional(),
  status: z.enum(UPDATABLE_STATUSES).optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

type Context = { params: Promise<{ blogId: string; offerId: string }> };

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
    const { blogId, offerId } = await context.params;

    const offer = await requireOfferForUser({
      userId: user.id,
      blogId,
      offerId,
    });

    return Response.json({ offer });
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
    const { blogId, offerId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('案件の内容を確認してください');
    }

    const input = parsed.data;

    const offer = await updateOfferForUser(
      { userId: user.id, blogId, offerId },
      {
        // **送られた項目だけを渡す。** 省いた項目を `undefined` で
        // 上書きすると、モジュール側が「変えない」と解釈できなくなる
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.aspName === undefined ? {} : { aspName: input.aspName }),
        ...(input.advertiserName === undefined
          ? {}
          : { advertiserName: input.advertiserName }),
        ...(input.landingPageUrl === undefined
          ? {}
          : { landingPageUrl: input.landingPageUrl }),
        ...(input.affiliateUrl === undefined
          ? {}
          : { affiliateUrl: input.affiliateUrl }),
        ...(input.rewardYen === undefined
          ? {}
          : { rewardYen: input.rewardYen }),
        ...(input.conversionType === undefined
          ? {}
          : { conversionType: input.conversionType }),
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
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsAt === undefined
          ? {}
          : { startsAt: toDate(input.startsAt) }),
        ...(input.endsAt === undefined ? {} : { endsAt: toDate(input.endsAt) }),
      },
    );

    return Response.json({ offer });
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
    const { blogId, offerId } = await context.params;

    // **物理削除しない。** 記事に埋め込んだリンクが残っている（D-1）
    const offer = await endOfferForUser({
      userId: user.id,
      blogId,
      offerId,
    });

    return Response.json({ offer });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
