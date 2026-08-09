/**
 * `app_settings` テーブルへのアクセス（TASKS H-7、Q-017）。
 *
 * **このモジュールだけが `app_settings` を触る**（MODULE_RULES 1）。
 *
 * 秘密は AES-256-GCM で暗号化して保存する（C-1）。**AAD に設定名を入れる** —
 * これが無いと、DBへ書ける立場の攻撃者が `MAIL_FROM` の暗号文を
 * `ANTHROPIC_API_KEY` の行へ移し替えられる（暗号文としては正しく復号される）。
 */

import { prisma } from '@/lib/db';
import { decryptSecret, encryptSecret, getEncryptionKey } from '@/lib/crypto';
import type { Secret } from '@/lib/crypto';

const SELECT = {
  key: true,
  value: true,
  valueEncrypted: true,
  isSecret: true,
  updatedAt: true,
  updatedByUserId: true,
} as const;

export interface SettingRow {
  key: string;
  value: string | null;
  valueEncrypted: string | null;
  isSecret: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

/** 暗号文をその設定名に結び付ける */
export function settingAad(key: string): string {
  return `app_setting:${key}`;
}

/** 保存されている行をすべて返す。**復号はしない** */
export async function listSettingRows(): Promise<SettingRow[]> {
  return prisma.appSetting.findMany({ select: SELECT });
}

/** 暗号文を復号する。失敗は呼び出し側で扱う（`DecryptionError`） */
export function decryptSettingValue(key: string, payload: string): Secret {
  return decryptSecret(payload, {
    key: getEncryptionKey(),
    aad: settingAad(key),
  });
}

/**
 * 値を保存する（無ければ作る）。
 *
 * **秘密かどうかで入る列が変わる。** 食い違いはDBの CHECK 制約
 * （`app_settings_secret_column`）でも拒まれる（H-7-schema）。
 */
export async function upsertSettingRow(params: {
  key: string;
  value: string;
  secret: boolean;
  actorUserId: string | null;
}): Promise<SettingRow> {
  const stored = params.secret
    ? {
        value: null,
        valueEncrypted: encryptSecret(params.value, {
          key: getEncryptionKey(),
          aad: settingAad(params.key),
        }),
      }
    : { value: params.value, valueEncrypted: null };

  return prisma.appSetting.upsert({
    where: { key: params.key },
    create: {
      key: params.key,
      isSecret: params.secret,
      updatedByUserId: params.actorUserId,
      ...stored,
    },
    update: {
      isSecret: params.secret,
      updatedByUserId: params.actorUserId,
      ...stored,
    },
    select: SELECT,
  });
}

/**
 * 設定を消す。
 *
 * **「空にする」ではなく行ごと消す。** 値の無い行を許すと、秘密なのに
 * 暗号文が無い行が生まれる（H-7-schema）。消せば解決順が環境変数・
 * コード既定へ落ちる。
 *
 * @returns 消したかどうか（無くても失敗にしない）
 */
export async function deleteSettingRow(key: string): Promise<boolean> {
  const { count } = await prisma.appSetting.deleteMany({ where: { key } });

  return count > 0;
}
