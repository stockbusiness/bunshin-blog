import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireConsentedUser } from '@/modules/auth';
import {
  createBlogForUser,
  getSlotUsageForUser,
  listBlogsForUser,
} from '@/modules/blogs';
import { requirePersonaForUser } from '@/modules/personas';

/**
 * `GET /api/blogs` / `POST /api/blogs`（SPEC 13.2、TASKS B-3）
 *
 * **一覧はセッションのユーザーで絞る。** クエリでユーザーを指定させない
 * （SPEC 14.1）。
 */

export const runtime = 'nodejs';

const createSchema = z.object({
  // どの分身の媒体か（A-2-R-2c）。**必須**
  personaId: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, {
      message: '英小文字・数字・ハイフンのみ',
    }),
  targetReader: z.string().min(1).max(500),
  // 省略可。省略すると空いている最小のスロットが割り当てられる（B-4）
  slotNumber: z.number().int().min(1).max(3).optional(),
  penName: z.string().max(100).optional(),
  purpose: z.enum(['AFFILIATE', 'DISPLAY_AD', 'MIXED']).optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));
    const [blogs, slots] = await Promise.all([
      listBlogsForUser(user.id),
      getSlotUsageForUser(user.id),
    ]);

    // 残枠を一緒に返す。一覧は CLOSED を含まないため、
    // クライアントは `blogs.length` から空きを計算できない（Q-008）
    return Response.json({
      blogs,
      slots: {
        limit: slots.limit,
        available: slots.available,
        remaining: slots.remaining,
      },
    });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireConsentedUser(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('ブログの内容を確認してください');
    }

    // **分身が使える状態かはここで見る**（MODULE_RULES 3「上位へ寄せる」）。
    //
    // `blogs` から `personas` を import すると循環する。**越境の防止は
    // DBの複合外部キーが担う**（A-2-R-2c-schema）ので、ここで確かめるのは
    // 「使い始めた分身か」という運用方針だけ。
    //
    // **`DRAFT` の分身でブログを作らせない。** 段階解放（ROADMAP 5章）は
    // `ACTIVE` の数を制限するもので、下書きのまま媒体を持てると
    // **初日に3ブログを立てられて制限が意味を失う**
    const persona = await requirePersonaForUser({
      userId: user.id,
      personaId: parsed.data.personaId,
    });

    if (persona.status !== 'ACTIVE') {
      throw AppError.validationFailed(
        '使い始めた分身を選んでください（下書きのままではブログを作れません）',
      );
    }

    // userId は入力からではなくセッションから取る
    const blog = await createBlogForUser(user.id, parsed.data);

    return Response.json({ blog }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
