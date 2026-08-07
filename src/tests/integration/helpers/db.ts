import { PrismaClient } from '@prisma/client';

/**
 * 統合テスト用のDBヘルパー（TASKS A-9）。
 *
 * **テストは実際のPostgreSQLに対して走る。** fake では、所有権検証の
 * ような「SQLの条件そのもの」を検証できないため。
 */

/**
 * テスト用のPrismaクライアント。
 *
 * `DATABASE_URL` が無い場合は、何を設定すべきかを明示して落とす。
 * 接続エラーの読み解きに時間を使わせない。
 */
export function createTestPrisma(): PrismaClient {
  const url = process.env['DATABASE_URL'];

  if (url === undefined || url.trim() === '') {
    throw new Error(
      [
        '統合テストには DATABASE_URL が必要です。',
        '',
        'ローカルで動かす場合の例:',
        '  docker run --rm -d -p 5432:5432 \\',
        '    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bunshin_test postgres:16',
        '  export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bunshin_test',
        '  npx prisma migrate deploy',
        '  npm run test:integration',
      ].join('\n'),
    );
  }

  return new PrismaClient({ log: ['warn', 'error'] });
}

/** マイグレーション管理用のテーブル。消してはならない */
const PRESERVED_TABLES = new Set(['_prisma_migrations']);

/**
 * 全テーブルのデータを消す。
 *
 * テーブルを1つずつ列挙するとテーブル追加のたびに更新漏れが起きるため、
 * `information_schema` から動的に集める。
 *
 * **`TRUNCATE ... CASCADE` を使う。** `deleteMany` を順に呼ぶと外部キーの
 * 削除順に依存し、テーブルが増えるたびに順番の調整が必要になる。
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );

  const targets = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.has(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length === 0) {
    throw new Error(
      'public スキーマにテーブルがありません。' +
        'npx prisma migrate deploy を実行してください',
    );
  }

  await prisma.$executeRawUnsafe(
    `truncate table ${targets.join(', ')} restart identity cascade`,
  );
}

/** マイグレーションが適用済みかを確認する */
export async function assertMigrationsApplied(
  prisma: PrismaClient,
): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `select count(*)::bigint as count from information_schema.tables
     where table_schema = 'public' and table_name = 'users'`,
  );

  if (Number(rows[0]?.count ?? 0) === 0) {
    throw new Error(
      'users テーブルがありません。npx prisma migrate deploy を実行してください',
    );
  }
}
