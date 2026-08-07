import { prisma } from '@/lib/db';

/**
 * `admin_login_tokens` へのアクセス（B-11）。
 *
 * **このモジュールだけが `admin_login_tokens` を触る**（MODULE_RULES 1、
 * 所有は `auth`）。
 *
 * ここは差し替え可能なインターフェースにしてある。**「1回だけ使える」の
 * 判定は fake でも書けるが、同時に2回叩かれたときに片方だけが通ることは
 * 実DBでしか確かめられない。** 統合テストで確認する。
 */

export interface AdminLoginTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface AdminLoginTokenDb {
  create(args: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<AdminLoginTokenRecord>;

  findByHash(tokenHash: string): Promise<AdminLoginTokenRecord | null>;

  /**
   * 未使用のものだけを使用済みにする。
   *
   * **更新できた件数を返す。** 「引いてから書く」を分けると、同時に
   * 2回叩かれたときに両方が通る。`WHERE used_at IS NULL` を条件に含めた
   * 1文で更新し、0件なら既に使われていたと判断する。
   */
  markUsed(args: { id: string; usedAt: Date }): Promise<number>;

  countIssuedSince(args: { userId: string; since: Date }): Promise<number>;
}

const prismaAdminLoginTokenDb: AdminLoginTokenDb = {
  create: (args) =>
    prisma.adminLoginToken.create({
      data: args,
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    }),

  findByHash: (tokenHash) =>
    prisma.adminLoginToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    }),

  markUsed: async ({ id, usedAt }) => {
    const result = await prisma.adminLoginToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt },
    });

    return result.count;
  },

  countIssuedSince: ({ userId, since }) =>
    prisma.adminLoginToken.count({
      where: { userId, createdAt: { gte: since } },
    }),
};

export interface AdminLoginDeps {
  tokens?: AdminLoginTokenDb;
  now?: () => Date;
}

export function resolveTokenDb(deps: AdminLoginDeps): AdminLoginTokenDb {
  return deps.tokens ?? prismaAdminLoginTokenDb;
}
