import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * YMYL ジャンルの種を見張る（Q-049、SPEC 9.2.2）。
 *
 * ## なぜ実DBではなくSQLを見るのか
 *
 * 統合テストの `resetDatabase` は **`genres` も消す。** そこで中身を
 * 確かめても、**テストが自分で入れた値を見ているだけ**になる。
 * 本番へ入るのはマイグレーションなので、**そのSQLを見張る。**
 *
 * ## 何を守っているのか
 *
 * `ymyl_risk` は **`genres` マスタの値**で、利用者の申告ではない
 * （`step1.ts`）。**`HIGH` なら無条件で停止する。** つまり
 * **この種に何を `HIGH` として書くかが、そのまま停止条件の実体になる。**
 *
 * 守りたいのは2つ。
 *
 * - **SPEC 9.2.2 に列挙された分野が、1つも欠けていない**
 *   （欠けると、その分野が素通りする）
 * - **種の行がすべて `HIGH`**
 *   （通すためのジャンルを種に混ぜない。実際に何を書けるかは案件と
 *   対になって決まるので、ADMIN が後から足す）
 */

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260815000000_seed_ymyl_genres/migration.sql',
);

/**
 * SPEC 9.2.2 の停止条件。
 *
 * > YMYL該当（医療・健康効果・投資・融資・保険・法律・就労）
 *
 * **解釈を足していない。** 何が YMYL かの線引きは SPEC 18章の
 * 未確定事項 11 で、まだ決まっていない。
 */
const REQUIRED = [
  '医療・健康',
  '投資・資産運用',
  '融資・ローン',
  '保険',
  '法律',
  '就労・転職',
];

const sql = readFileSync(MIGRATION, 'utf8');

/** `(gen_random_uuid(), '名前', '分類', ..., 'リスク', ...)` の行を拾う */
function seededRows(): { name: string; category: string; risk: string }[] {
  const rows: { name: string; category: string; risk: string }[] = [];
  const pattern =
    /\(gen_random_uuid\(\),\s*'([^']+)',\s*'([^']+)',\s*'[^']+',\s*'([^']+)'/g;

  for (const match of sql.matchAll(pattern)) {
    rows.push({
      name: match[1] ?? '',
      category: match[2] ?? '',
      risk: match[3] ?? '',
    });
  }

  return rows;
}

describe('YMYL ジャンルの種', () => {
  /** **収集そのものが壊れていたら、以降の確認は空振りで通る** */
  it('種の行を読み取れている', () => {
    expect(seededRows()).toHaveLength(REQUIRED.length);
  });

  it('SPEC 9.2.2 の分野が1つも欠けていない', () => {
    const names = seededRows().map((row) => row.name);

    for (const required of REQUIRED) {
      expect(names).toContain(required);
    }
  });

  /**
   * **通すためのジャンルを種に混ぜない。** 案件0件は停止条件なので、
   * 先に候補だけ並べると選べないジャンルが並ぶ（Q-049）
   */
  it('種の行はすべて HIGH', () => {
    for (const row of seededRows()) {
      expect(row.risk).toBe('HIGH');
    }
  });

  /** **`ymylRisk` の単位は `category`**（Q-049 の2階層） */
  it('種は分類と名前が一致している（粗い階層）', () => {
    for (const row of seededRows()) {
      expect(row.category).toBe(row.name);
    }
  });

  /**
   * **何度流れても同じ結果になること。** `migrate deploy` は
   * 本番で1度しか流れないが、**取り込み直しや復旧で二度流れうる**
   */
  it('二度流しても増えない', () => {
    expect(sql).toContain('ON CONFLICT ("name") DO NOTHING');
  });
});
