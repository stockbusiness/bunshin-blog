import { PrismaClient } from '@prisma/client';

/**
 * Prisma クライアント（B-2）。
 *
 * 開発中は Next.js のホットリロードで module が再評価されるため、
 * そのたびに接続が増えないよう globalThis に保持する。
 *
 * **このクライアントを `src/modules/` の外から直接使わない。**
 * テーブルへのアクセスは所有モジュールの公開関数を経由する
 * （MODULE_RULES 1）。
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // クエリ本体をログに出さない。パラメータに秘密情報が混ざりうる
    log: ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
