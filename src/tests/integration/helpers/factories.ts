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
  /** この媒体を書く分身（A-2-R-2c） */
  personaId: string;
}

/**
 * ブログを作る。
 *
 * `slot_number` は 1〜3 のみ（DB の CHECK 制約 `blogs_slot_range`）。
 *
 * **分身も一緒に作る**（A-2-R-2c・A-2-R-2d）。ブログは分身の媒体で、
 * `persona_id` が無いと記事生成が書き手を決められない。
 * `personaId` を渡せばその分身に紐づける。
 */
export async function createBlog(
  prisma: PrismaClient,
  userId: string,
  overrides: { slotNumber?: number; name?: string; personaId?: string } = {},
): Promise<CreatedBlog> {
  const suffix = nextSuffix();
  const personaId =
    overrides.personaId ?? (await createPersona(prisma, userId)).id;

  const blog = await prisma.blog.create({
    data: {
      userId,
      personaId,
      name: overrides.name ?? `ブログ${suffix}`,
      slug: `blog-${suffix}`,
      targetReader: 'テスト読者',
      articleRatio: { revenue: 7, traffic: 23, weeklyPublishCap: 4 },
      slotNumber: overrides.slotNumber ?? 1,
    },
  });

  return {
    id: blog.id,
    userId: blog.userId,
    slotNumber: blog.slotNumber,
    personaId,
  };
}

/**
 * `ACTIVE` の分身を作る（A-2-R-2c）。
 *
 * **`createBlogForUser` はこれが先に無いと呼べない。** ブログは分身の媒体で、
 * `personaId` は必須（`blogs.persona_id` は A-2-R-3 で NOT NULL になる）。
 *
 * `personas` テーブルへ直接入れる。段階解放（ROADMAP 5章）を通すと、
 * **ブログの準備だけのために参加日を操作することになる。**
 */
export async function createPersona(
  prisma: PrismaClient,
  userId: string,
  overrides: {
    name?: string;
    status?: 'DRAFT' | 'ACTIVE' | 'PAUSED';
    /** 文体。**重ね合わせ（A-2-R-2d）を確かめるテストが固定する** */
    tone?: {
      style: string;
      emojiLevel: string;
      lineBreak: string;
      politeness: string;
    };
  } = {},
): Promise<{ id: string }> {
  const suffix = nextSuffix();

  const persona = await prisma.persona.create({
    data: {
      userId,
      name: overrides.name ?? `分身${suffix}`,
      personaType: 'SELF',
      identity: {
        name: `まこと${suffix}`,
        firstPerson: '私',
        background: '30代の会社員',
        tone: overrides.tone ?? {
          style: 'やわらかい',
          emojiLevel: 'low',
          lineBreak: 'normal',
          politeness: 'です・ます',
        },
        values: { priorities: ['正確さ'], avoid: ['煽り'] },
        ngExpressions: ['絶対に儲かる'],
      },
      expertise: {
        fields: ['家計管理'],
        sources: ['総務省統計'],
        evaluationCriteria: ['実際に使ったか'],
      },
      audience: {
        ageRange: '30代',
        situation: '子育て中',
        knowledgeLevel: 'beginner',
        problems: ['固定費が下がらない'],
        searchIntents: ['格安SIM 比較'],
      },
      business: {
        revenuePolicy: '使ったものだけ紹介する',
        monthlyGoalYen: 30_000,
        kpis: ['成果件数'],
        exitCriteria: '3か月で表示回数が伸びなければ畳む',
      },
      status: overrides.status ?? 'ACTIVE',
      activatedAt: new Date('2026-08-01T00:00:00Z'),
    },
    select: { id: true },
  });

  return persona;
}
