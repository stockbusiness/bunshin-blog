import type { PrismaClient } from '@prisma/client';

/**
 * 統合テスト用のデータ作成（TASKS A-9）。
 *
 * **越境のテストで「別ユーザー」を2人作る場面が繰り返し出る**ため、
 * ここに集約する（C-6 のテナント越境テストが主な利用者）。
 */

let sequence = 0;

/** テストごとに衝突しない識別子を作る */
function nextSuffix(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export interface CreatedUser {
  id: string;
  lineUserId: string;
  displayName: string;
}

/** 同意済み・ACTIVE のユーザーを作る */
export async function createUser(
  prisma: PrismaClient,
  overrides: {
    displayName?: string;
    status?: 'INVITED' | 'ACTIVE' | 'PAUSED' | 'WITHDRAWN';
    consented?: boolean;
  } = {},
): Promise<CreatedUser> {
  const suffix = nextSuffix();
  const consented = overrides.consented ?? true;
  const consentedAt = consented ? new Date('2026-08-01T00:00:00Z') : null;

  const user = await prisma.user.create({
    data: {
      lineUserId: `U-test-${suffix}`,
      displayName: overrides.displayName ?? `テスト${suffix}`,
      status: overrides.status ?? 'ACTIVE',
      termsAcceptedAt: consentedAt,
      dataUseConsentAt: consentedAt,
    },
  });

  return {
    id: user.id,
    lineUserId: user.lineUserId ?? '',
    displayName: user.displayName,
  };
}

export interface CreatedBlog {
  id: string;
  userId: string;
  slotNumber: number;
}

/**
 * ブログを作る。
 *
 * `slot_number` は 1〜3 のみ（DB の CHECK 制約 `blogs_slot_range`）。
 */
export async function createBlog(
  prisma: PrismaClient,
  userId: string,
  overrides: { slotNumber?: number; name?: string } = {},
): Promise<CreatedBlog> {
  const suffix = nextSuffix();

  const blog = await prisma.blog.create({
    data: {
      userId,
      name: overrides.name ?? `ブログ${suffix}`,
      slug: `blog-${suffix}`,
      targetReader: 'テスト読者',
      articleRatio: { revenue: 7, traffic: 23, weeklyPublishCap: 4 },
      slotNumber: overrides.slotNumber ?? 1,
    },
  });

  return { id: blog.id, userId: blog.userId, slotNumber: blog.slotNumber };
}
