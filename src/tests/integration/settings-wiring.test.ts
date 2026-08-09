import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resetEncryptionKeyCache } from '@/lib/crypto';
import { recordAiUsageAndNotify } from '@/modules/ai-costs';
import { saveSettingForAdmin } from '@/modules/settings';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';
import { createUser } from './helpers/factories';

/**
 * 保存した設定が**実際に効く**ことを確かめる（TASKS H-10）。
 *
 * H-7〜H-9 で保存も表示もできるようになったが、**読む側が
 * `process.env` を直接見ている間は何も変わらない。** そこを塞いだのが
 * H-10 で、その確認がこのファイル。
 *
 * 環境変数には何も入れず、**DBに保存した値だけ**で通知が出ることを見る。
 */

let prisma: PrismaClient;
let userId: string;

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

let sent: SentMail[];

const mailer = {
  send: async (message: SentMail) => {
    sent.push(message);
  },
};

function usage(costUsd: number) {
  return {
    userId,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    operation: 'ARTICLE_BODY',
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  };
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);

  process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  resetEncryptionKeyCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const user = await createUser(prisma);
  userId = user.id;
  sent = [];

  // **環境変数側には何も置かない。** DBの設定だけで動くことを見る
  delete process.env['AI_BUDGET_USER_MONTHLY_USD'];
  delete process.env['ADMIN_ALERT_EMAIL'];
});

describe('管理画面で設定した値が使われる', () => {
  /**
   * **これが H-10 の完了条件。** 予算をDBに保存しただけで判定が変わる。
   * 以前は `process.env` を直接読んでいたため、保存しても効かなかった。
   */
  it('DBに保存した予算で通知が出る', async () => {
    await saveSettingForAdmin({
      key: 'AI_BUDGET_USER_MONTHLY_USD',
      value: '1',
      actorUserId: null,
    });
    await saveSettingForAdmin({
      key: 'ADMIN_ALERT_EMAIL',
      value: 'admin@example.com',
      actorUserId: null,
    });

    // 0 → 0.85（85%）。80%を跨ぐ
    const { crossings } = await recordAiUsageAndNotify(usage(0.85), {
      mailer,
    });

    expect(crossings.map((entry) => entry.threshold)).toEqual([0.8]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('admin@example.com');
  });

  /** 予算が未設定なら鳴らない（DBにも環境変数にも無い） */
  it('どこにも予算が無ければ通知しない', async () => {
    const { crossings } = await recordAiUsageAndNotify(usage(999), { mailer });

    expect(crossings).toEqual([]);
    expect(sent).toEqual([]);
  });

  /** **画面で設定した値が環境変数に勝つ**（解決順。H-7） */
  it('DBの予算が環境変数より優先される', async () => {
    process.env['AI_BUDGET_USER_MONTHLY_USD'] = '100';
    process.env['ADMIN_ALERT_EMAIL'] = 'from-env@example.com';

    await saveSettingForAdmin({
      key: 'AI_BUDGET_USER_MONTHLY_USD',
      value: '1',
      actorUserId: null,
    });
    await saveSettingForAdmin({
      key: 'ADMIN_ALERT_EMAIL',
      value: 'from-db@example.com',
      actorUserId: null,
    });

    // 環境変数の 100 のままなら 0.85 は何も跨がない
    const { crossings } = await recordAiUsageAndNotify(usage(0.85), {
      mailer,
    });

    expect(crossings.map((entry) => entry.threshold)).toEqual([0.8]);
    expect(sent[0]?.to).toBe('from-db@example.com');
  });

  /** 解除すれば環境変数へ落ちる */
  it('DBに無ければ環境変数が使われる', async () => {
    process.env['AI_BUDGET_USER_MONTHLY_USD'] = '1';
    process.env['ADMIN_ALERT_EMAIL'] = 'from-env@example.com';

    const { crossings } = await recordAiUsageAndNotify(usage(0.85), {
      mailer,
    });

    expect(crossings.map((entry) => entry.threshold)).toEqual([0.8]);
    expect(sent[0]?.to).toBe('from-env@example.com');
  });
});
