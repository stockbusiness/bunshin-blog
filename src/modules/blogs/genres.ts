/**
 * `genres` マスタの参照（TASKS E-4、SPEC 9.2.2）。
 *
 * **`genres` は `blogs` モジュールの所有テーブル**（MODULE_RULES 1）。
 * ジャンル審査（`content-planning`）はここを経由して読む。
 *
 * **利用者に紐づかない。** マスタなので `...ForUser` の形にならない。
 * 誰が引いても同じ値が返る（`ymyl_risk` を利用者の申告で上書きしない）。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import type { AppGenre } from './types';

const SELECT = {
  id: true,
  name: true,
  category: true,
  ymylRisk: true,
  status: true,
} as const;

/** ジャンルを1件引く。無ければ `null` */
export async function findGenre(genreId: string): Promise<AppGenre | null> {
  return prisma.genre.findUnique({ where: { id: genreId }, select: SELECT });
}

/** 審査に使えるジャンルを一覧する（`REJECTED` は出さない） */
export async function listSelectableGenres(): Promise<AppGenre[]> {
  return prisma.genre.findMany({
    where: { status: { not: 'REJECTED' } },
    // `created_at` を持たないため名前順。呼ぶたびに並びが変わらないようにする
    orderBy: [{ name: 'asc' }],
    select: SELECT,
  });
}

/**
 * ジャンルを1件足す（Q-049。**ADMIN のみ**）。
 *
 * ## なぜ画面から足せるようにするか
 *
 * **種で入れるのは SPEC 9.2.2 に列挙された YMYL の6分野だけ**である
 * （マイグレーション `seed_ymyl_genres`）。**通すためのジャンルは
 * 種に入れていない。**
 *
 * 理由は、**実際に何を書けるかが案件と対になって決まる**ため。
 * 案件が0件のジャンルは停止条件に当たる（`step1.ts`）ので、
 * **先に候補だけ並べると、選べないジャンルが並ぶ。**
 *
 * ## `ymylRisk` を利用者に決めさせない
 *
 * `step1.ts` が「**`genres` マスタの値。利用者の申告ではない**」と
 * 書いているとおり、**`HIGH` なら無条件で停止する。** ここを自己申告に
 * すると、**停止条件を申告で回避できる。** だから ADMIN だけが足せる。
 *
 * ## 粒度は2階層に分ける（Q-049）
 *
 * | 列 | 粒度 | 使い道 |
 * |---|---|---|
 * | `category` | 粗い | **`ymylRisk` の単位**・ジャンル別の集計 |
 * | `name` | 細かい | **AIに渡す言葉**（キーワード・検索意図。STEP 2/4） |
 *
 * **記事本文の生成にジャンルは渡っていない**（`ArticleGenerationInput`
 * に無い）。細かくして効くのは**題材選び**であって、書きぶりではない。
 *
 * **同じ `category` の行は同じ `ymylRisk` にする。** DBは強制しないので、
 * 揃っていないものは足すときに弾く（下記）。**1つ付け忘れると、
 * そこだけ停止条件を素通りする。**
 *
 * @throws {AppError} 同じ名前が既にある場合（409）
 * @throws {AppError} 同じ分類の既存行と `ymylRisk` が食い違う場合（422）
 */
export async function createGenre(input: {
  name: string;
  category: string;
  ymylRisk: AppGenre['ymylRisk'];
  competitionLevel?: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  notes?: string | null;
}): Promise<AppGenre> {
  // **同じ分類の中で `ymylRisk` を揃える。** 「投資＞つみたてNISA」だけ
  // `LOW` になっていると、そこだけ停止条件を素通りする
  const sibling = await prisma.genre.findFirst({
    where: { category: input.category },
    select: { ymylRisk: true },
  });

  if (sibling !== null && sibling.ymylRisk !== input.ymylRisk) {
    throw AppError.validationFailed(
      `分類「${input.category}」は既に ${sibling.ymylRisk} で登録されています。同じ分類の中では揃えてください`,
    );
  }

  try {
    return await prisma.genre.create({
      data: {
        name: input.name,
        category: input.category,
        ymylRisk: input.ymylRisk,
        competitionLevel: input.competitionLevel ?? 'UNKNOWN',
        notes: input.notes ?? null,
        // **足した時点では候補。** 審査を経ていない
        status: 'CANDIDATE',
      },
      select: SELECT,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new AppError(
        'GENRE_NAME_TAKEN',
        409,
        'その名前のジャンルはすでにあります',
      );
    }

    throw error;
  }
}
