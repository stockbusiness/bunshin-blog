/**
 * `genres` マスタの参照（TASKS E-4、SPEC 9.2.2）。
 *
 * **`genres` は `blogs` モジュールの所有テーブル**（MODULE_RULES 1）。
 * ジャンル審査（`content-planning`）はここを経由して読む。
 *
 * **利用者に紐づかない。** マスタなので `...ForUser` の形にならない。
 * 誰が引いても同じ値が返る（`ymyl_risk` を利用者の申告で上書きしない）。
 */

import { prisma } from '@/lib/db';
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
