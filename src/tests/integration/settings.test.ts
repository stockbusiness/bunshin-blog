import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { encryptSecret } from '@/lib/crypto';
import { resetEncryptionKeyCache } from '@/lib/crypto';
import {
  SETTING_ERROR_CODES,
  clearSettingForAdmin,
  getRuntimeEnv,
  listSettingsForAdmin,
  saveSettingForAdmin,
} from '@/modules/settings';
import {
  assertMigrationsApplied,
  createTestPrisma,
  resetDatabase,
} from './helpers/db';

/**
 * 設定の解決と保存を**実PostgreSQL・実暗号化で**確かめる（TASKS H-7、Q-017）。
 *
 * 完了条件は2つ。
 *
 * 1. **保存済みの秘密を復号して返す入口が無い**
 * 2. **解決順（DB → 環境変数 → コード既定）がテストで確かめられる**
 *
 * 差し替えでは確かめられない — 暗号文がDBのどの列に入るか、AADが効くか、
 * CHECK 制約に掛かるかは、実物でしか分からない。
 */

let prisma: PrismaClient;

/** ADMIN の代わり。`updated_by_user_id` の外部キーを満たすために要る */
async function createAdmin(): Promise<string> {
  const user = await prisma.user.create({
    data: { displayName: '管理者', role: 'ADMIN' },
    select: { id: true },
  });

  return user.id;
}

async function rawRow(key: string) {
  return prisma.appSetting.findUnique({
    where: { key },
    select: { value: true, valueEncrypted: true, isSecret: true },
  });
}

function viewOf(
  views: Awaited<ReturnType<typeof listSettingsForAdmin>>,
  key: string,
) {
  const view = views.find((candidate) => candidate.key === key);

  if (view === undefined) {
    throw new Error(`${key} が一覧にありません`);
  }

  return view;
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await assertMigrationsApplied(prisma);

  // 実物の鍵で暗号化する。テスト用に固定の値を使う
  process.env['ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  resetEncryptionKeyCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('秘密の保存', () => {
  /** **これが完了条件。** 平文の列には入らない */
  it('APIキーは暗号化されて入る', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-0123456789ABCD',
      actorUserId: await createAdmin(),
    });

    const row = await rawRow('ANTHROPIC_API_KEY');

    expect(row?.isSecret).toBe(true);
    expect(row?.value).toBeNull();
    expect(row?.valueEncrypted).toMatch(/^v1\./);
    expect(row?.valueEncrypted).not.toContain('sk-ant-0123456789ABCD');
  });

  /** **保存済みの秘密を読み返す入口が無い**（Q-017） */
  it('一覧に平文が出ない', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-0123456789ABCD',
      actorUserId: null,
    });

    const views = await listSettingsForAdmin({});
    const view = viewOf(views, 'ANTHROPIC_API_KEY');

    expect(view.display).toBe('••••••••ABCD');
    expect(JSON.stringify(views)).not.toContain('sk-ant-0123456789ABCD');
  });

  it('保存の戻り値にも平文が出ない', async () => {
    const saved = await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-0123456789ABCD',
      actorUserId: null,
    });

    expect(JSON.stringify(saved)).not.toContain('sk-ant-0123456789ABCD');
    expect(saved.source).toBe('DB');
  });

  it('秘密でない設定はそのまま読める', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_STANDARD',
      value: 'claude-sonnet-5',
      actorUserId: null,
    });

    const row = await rawRow('AI_MODEL_STANDARD');
    expect(row?.value).toBe('claude-sonnet-5');
    expect(row?.valueEncrypted).toBeNull();

    const view = viewOf(await listSettingsForAdmin({}), 'AI_MODEL_STANDARD');
    expect(view.display).toBe('claude-sonnet-5');
  });

  it('上書きで差し替えられる', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-old-00000WXYZ',
      actorUserId: null,
    });
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-new-11111ABCD',
      actorUserId: null,
    });

    expect(await prisma.appSetting.count()).toBe(1);

    const env = await getRuntimeEnv({});
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-new-11111ABCD');
  });

  it('誰が変えたかを残す', async () => {
    const adminId = await createAdmin();

    await saveSettingForAdmin({
      key: 'MAIL_FROM',
      value: 'a@example.com',
      actorUserId: adminId,
    });

    const view = viewOf(await listSettingsForAdmin({}), 'MAIL_FROM');
    expect(view.updatedByUserId).toBe(adminId);
    expect(view.updatedAt).toBeInstanceOf(Date);
  });

  /**
   * **AADに設定名を入れてある。** これが無いと、DBへ書ける立場の攻撃者が
   * `MAIL_FROM` の暗号文を `ANTHROPIC_API_KEY` の行へ移し替えられる。
   */
  it('暗号文を別の設定名の行へ移し替えられない', async () => {
    await saveSettingForAdmin({
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-0123456789ABCD',
      actorUserId: null,
    });

    const row = await rawRow('ANTHROPIC_API_KEY');

    await prisma.appSetting.create({
      data: {
        key: 'RESEND_API_KEY',
        valueEncrypted: row?.valueEncrypted ?? '',
        isSecret: true,
      },
    });

    const env = await getRuntimeEnv({});
    expect(env['RESEND_API_KEY']).toBeUndefined();

    const view = viewOf(await listSettingsForAdmin({}), 'RESEND_API_KEY');
    expect(view.source).toBe('UNREADABLE');
  });

  /**
   * **黙って環境変数へ落とさない。** 鍵を変えたときに「設定したのに
   * 効かない」の理由が分からなくなる。
   */
  it('復号できない行は UNREADABLE として出す', async () => {
    await prisma.appSetting.create({
      data: {
        key: 'ANTHROPIC_API_KEY',
        // 別の鍵で暗号化した値
        valueEncrypted: encryptSecret('sk-ant-other', {
          key: randomBytes(32),
          aad: 'app_setting:ANTHROPIC_API_KEY',
        }),
        isSecret: true,
      },
    });

    const view = viewOf(
      await listSettingsForAdmin({ ANTHROPIC_API_KEY: 'sk-ant-from-env' }),
      'ANTHROPIC_API_KEY',
    );

    expect(view.source).toBe('UNREADABLE');
    expect(view.display).toBeNull();
  });
});

describe('解決順（DB → 環境変数 → コード既定）', () => {
  /** **これが完了条件。** 画面で設定した値が環境変数に勝つ */
  it('DBの値が環境変数に勝つ', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_STANDARD',
      value: 'from-db',
      actorUserId: null,
    });

    const env = await getRuntimeEnv({ AI_MODEL_STANDARD: 'from-env' });

    expect(env['AI_MODEL_STANDARD']).toBe('from-db');
  });

  it('DBに無ければ環境変数が使われる', async () => {
    const env = await getRuntimeEnv({ AI_MODEL_STANDARD: 'from-env' });

    expect(env['AI_MODEL_STANDARD']).toBe('from-env');
  });

  /** 既定値はここに持たない。読む側（`src/lib/ai/config.ts`）が落ちる先 */
  it('どちらにも無ければ辞書に現れない', async () => {
    const env = await getRuntimeEnv({});

    expect(env['AI_MODEL_STANDARD']).toBeUndefined();
  });

  it('環境変数のほかの値を消さない', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_STANDARD',
      value: 'from-db',
      actorUserId: null,
    });

    const env = await getRuntimeEnv({ DATABASE_URL: 'postgres://x' });

    expect(env['DATABASE_URL']).toBe('postgres://x');
  });

  /** 一覧から外した項目の古い行が、環境変数として注入され続けないこと */
  it('一覧にない名前は注入しない', async () => {
    await prisma.appSetting.create({
      data: {
        key: 'DATABASE_URL',
        value: 'postgres://attacker',
        isSecret: false,
      },
    });

    const env = await getRuntimeEnv({ DATABASE_URL: 'postgres://real' });

    expect(env['DATABASE_URL']).toBe('postgres://real');
  });

  it('一覧はどこから来た値かを返す', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_LOW',
      value: 'from-db',
      actorUserId: null,
    });

    const views = await listSettingsForAdmin({ AI_MODEL_HIGH: 'from-env' });

    expect(viewOf(views, 'AI_MODEL_LOW').source).toBe('DB');
    expect(viewOf(views, 'AI_MODEL_HIGH').source).toBe('ENV');
    expect(viewOf(views, 'AI_MODEL_HIGH').display).toBe('from-env');
    expect(viewOf(views, 'AI_MODEL_STANDARD').source).toBe('UNSET');
    expect(viewOf(views, 'AI_MODEL_STANDARD').display).toBeNull();
  });

  /** 環境変数側の秘密も伏せる。効いている鍵の末尾は突き合わせに要る */
  it('環境変数の秘密も伏せて出す', async () => {
    const views = await listSettingsForAdmin({
      ANTHROPIC_API_KEY: 'sk-ant-env-000000WXYZ',
    });

    expect(viewOf(views, 'ANTHROPIC_API_KEY').display).toBe('••••••••WXYZ');
  });
});

describe('設定の解除', () => {
  /** **行ごと消す。** 値の無い行を許すと、秘密なのに暗号文が無い行が生まれる */
  it('消すと行が無くなる', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_STANDARD',
      value: 'from-db',
      actorUserId: null,
    });

    await clearSettingForAdmin({ key: 'AI_MODEL_STANDARD' });

    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('消すと環境変数へ落ちる', async () => {
    await saveSettingForAdmin({
      key: 'AI_MODEL_STANDARD',
      value: 'from-db',
      actorUserId: null,
    });
    await clearSettingForAdmin({ key: 'AI_MODEL_STANDARD' });

    const env = await getRuntimeEnv({ AI_MODEL_STANDARD: 'from-env' });

    expect(env['AI_MODEL_STANDARD']).toBe('from-env');
  });

  it('設定されていなければ 404', async () => {
    await expect(
      clearSettingForAdmin({ key: 'AI_MODEL_STANDARD' }),
    ).rejects.toMatchObject({
      code: SETTING_ERROR_CODES.notFound,
      status: 404,
    });
  });
});

describe('設定できない名前', () => {
  /**
   * **任意の名前を受け取らない。** 受け取れると、管理画面が
   * 「環境変数を何でも書き換えられる入口」になる。
   */
  it.each([['DATABASE_URL'], ['ENCRYPTION_KEY'], ['SESSION_SECRET']])(
    '%s は保存できない',
    async (key) => {
      await expect(
        saveSettingForAdmin({ key, value: 'x', actorUserId: null }),
      ).rejects.toMatchObject({ code: SETTING_ERROR_CODES.unknownKey });

      expect(await prisma.appSetting.count()).toBe(0);
    },
  );

  it('設定できない名前は消せもしない', async () => {
    await expect(
      clearSettingForAdmin({ key: 'ENCRYPTION_KEY' }),
    ).rejects.toMatchObject({ code: SETTING_ERROR_CODES.unknownKey });
  });
});
