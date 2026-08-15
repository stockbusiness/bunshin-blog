import { z } from 'zod';
import { AppError, toErrorHttpResponse } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { createGenre, listSelectableGenres } from '@/modules/blogs';

/**
 * `GET|POST /api/admin/genres`（Q-049、E-4、SPEC 9.2.2）
 *
 * ジャンルのマスタ。**ADMIN だけ。**
 *
 * ## なぜモニターに開かないか
 *
 * `ymyl_risk` は **`genres` マスタの値で、利用者の申告ではない**
 * （`step1.ts`）。**`HIGH` なら無条件で停止する。** 自己申告にすると、
 * **停止条件を申告で回避できる。**
 *
 * ## 種に入っているのは YMYL だけ
 *
 * マイグレーション `seed_ymyl_genres` が入れるのは、SPEC 9.2.2 に
 * 列挙された6分野だけ。**通すためのジャンルはここから足す。**
 * 実際に何を書けるかは**案件と対になって決まる**ため
 * （案件0件は停止条件）、先に候補だけ並べても選べない。
 */

export const runtime = 'nodejs';

const YMYL_RISKS = ['HIGH', 'MEDIUM', 'LOW'] as const;
const COMPETITION_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;

const createSchema = z.object({
  /** **AIに渡る言葉**（STEP 2/4 のキーワード・検索意図）。細かいほうがよい */
  name: z.string().min(1).max(100),
  /** **`ymylRisk` の単位。** 集計もここで取る（Q-049 の2階層） */
  category: z.string().min(1).max(100),
  ymylRisk: z.enum(YMYL_RISKS),
  competitionLevel: z.enum(COMPETITION_LEVELS).optional(),
  notes: z.string().max(500).nullable().optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    return Response.json({ genres: await listSelectableGenres() });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin(request.headers.get('cookie'));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw AppError.badRequest('リクエストの形式が不正です');
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.validationFailed('ジャンルの内容を確認してください');
    }

    const input = parsed.data;

    const genre = await createGenre({
      name: input.name,
      category: input.category,
      ymylRisk: input.ymylRisk,
      ...(input.competitionLevel === undefined
        ? {}
        : { competitionLevel: input.competitionLevel }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    });

    return Response.json({ genre }, { status: 201 });
  } catch (error) {
    return toErrorHttpResponse(error);
  }
}
