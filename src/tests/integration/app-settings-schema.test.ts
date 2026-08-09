import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * `app_settings` の制約を**実PostgreSQLで**確かめる（TASKS H-7-schema、Q-017）。
 *
 * 確かめるのは1点だけ — **秘密が平文の列に入らない。**
 *
 * これをアプリ側の書き方に任せると、入口が増えたときに漏れて
 * 「APIキーが平文で保存されたまま誰も気づかない」が起きる。C-6 と同じ筋で、
 * **迂回できない場所（DB）に置いたことを確かめる。**
 *
 * 読み書きの実装は H-7。ここでは生のSQLで直接入れて確かめる。
 */

let prisma: PrismaClient;

async function insert(row: {
  key: string;
  value?: string | null;
  valueEncrypted?: string | null;
  isSecret: boolean;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `insert into app_settings (id, key, value, value_encrypted, is_secret, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, now())`,
    row.key,
    row.value ?? null,
    row.valueEncrypted ?? null,
    row.isSecret,
  );
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('秘密は暗号化列にしか入らない', () => {
  /** **これが H-7-schema の完了条件。** */
  it('秘密を平文の列へ入れられない', async () => {
    await expect(
      insert({
        key: 'ANTHROPIC_API_KEY',
        value: 'sk-ant-plaintext',
        isSecret: true,
      }),
    ).rejects.toThrow(/app_settings_secret_column/);

    expect(await prisma.appSetting.count()).toBe(0);
  });

  /** 逆も塞ぐ。復号できない値を平文として読んでしまう */
  it('秘密でない値を暗号化列へ入れられない', async () => {
    await expect(
      insert({
        key: 'AI_PROVIDER',
        valueEncrypted: 'v1.aaa.bbb.ccc',
        isSecret: false,
      }),
    ).rejects.toThrow(/app_settings_secret_column/);
  });

  /**
   * **値の無い行を作れない。**
   *
   * 設定を解除したいときは行ごと消す（解決順が環境変数・コード既定へ落ちる）。
   * 「値が空の行」を許すと、設定されているのに効かない状態が生まれる。
   */
  it('どちらの列も空の行を作れない', async () => {
    await expect(insert({ key: 'MAIL_FROM', isSecret: false })).rejects.toThrow(
      /app_settings_secret_column/,
    );

    await expect(
      insert({ key: 'ANTHROPIC_API_KEY', isSecret: true }),
    ).rejects.toThrow(/app_settings_secret_column/);
  });

  it('両方の列が埋まった行を作れない', async () => {
    await expect(
      insert({
        key: 'MAIL_FROM',
        value: 'a@example.com',
        valueEncrypted: 'v1.aaa.bbb.ccc',
        isSecret: true,
      }),
    ).rejects.toThrow(/app_settings_secret_column/);
  });

  it('正しい形なら入る', async () => {
    await insert({ key: 'AI_PROVIDER', value: 'anthropic', isSecret: false });
    await insert({
      key: 'ANTHROPIC_API_KEY',
      valueEncrypted: 'v1.aaa.bbb.ccc',
      isSecret: true,
    });

    expect(await prisma.appSetting.count()).toBe(2);
  });
});

describe('設定名', () => {
  /** 環境変数と同じ綴りにして、解決順（DB→環境変数→既定）を追いやすくする */
  it.each([['ai_provider'], ['1AI'], ['AI-PROVIDER'], ['AI PROVIDER'], ['']])(
    '%s は受け付けない',
    async (key) => {
      await expect(
        insert({ key, value: 'x', isSecret: false }),
      ).rejects.toThrow(/app_settings_key_format/);
    },
  );

  it('同じ設定名を2つ持てない', async () => {
    await insert({ key: 'MAIL_FROM', value: 'a@example.com', isSecret: false });

    await expect(
      insert({ key: 'MAIL_FROM', value: 'b@example.com', isSecret: false }),
      // 一意制約の違反は制約名を返さないため、SQLSTATE で見る
    ).rejects.toThrow(/23505/);
  });
});
