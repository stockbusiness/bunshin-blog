/**
 * 設定の解決（TASKS H-7、OPEN_QUESTIONS Q-017）。
 *
 * ## 解決順は DB → 環境変数 → コード既定
 *
 * DBを先にするのは、**「画面で設定したのに効かない」が最も原因を
 * 追いにくい失敗**だから。環境変数が勝つ順だと、設定できる画面がある
 * のに値が変わらず、理由がどこにも出ない。
 *
 * コード既定はここに持たない。未設定なら**その名前を辞書に入れない**ので、
 * 読む側（`src/lib/ai/config.ts` など）が自分の既定へ落ちる。既定値の
 * 置き場所が2か所になるのを避ける。
 *
 * ## キャッシュを持たない
 *
 * 設定を読むのはAI呼び出しやメール送信の直前で、**元々ネットワークを
 * 待つ処理の一部**。索引の効いたSELECT 1回は誤差に沈む。持つと
 * 「画面で変えたのに効かない時間」が生まれ、しかもサーバーレスでは
 * インスタンスごとに切れる時期が違うため再現しにくい。
 *
 * ## 復号できない行は「無い」ことにしない
 *
 * `ENCRYPTION_KEY` を変えると保存済みの秘密は復号できない。**黙って
 * 環境変数へ落とすと、設定が効かない理由が分からなくなる。** 値としては
 * 使わないが、状態は `UNREADABLE` として画面に出す。
 */

import { DecryptionError } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { isSettingKey } from './catalog';
import { decryptSettingValue, listSettingRows } from './repository';
import type { SettingSource } from './types';

export interface StoredSetting {
  /** 復号済みの値。復号できなければ `null` */
  value: string | null;
  unreadable: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

/**
 * DBに保存されている設定を読む。
 *
 * **一覧にない名前は捨てる。** 項目を後から外したとき、古い行が
 * 環境変数として注入され続けるのを防ぐ。
 *
 * **サーバー専用。** 秘密の平文を含むため、この戻り値をそのまま
 * レスポンスへ入れない（MODULE_RULES 4）。
 */
export async function readStoredSettings(): Promise<
  Map<string, StoredSetting>
> {
  const rows = await listSettingRows();
  const result = new Map<string, StoredSetting>();

  for (const row of rows) {
    if (!isSettingKey(row.key)) {
      continue;
    }

    const base = {
      updatedAt: row.updatedAt,
      updatedByUserId: row.updatedByUserId,
    };

    if (!row.isSecret) {
      result.set(row.key, { ...base, value: row.value, unreadable: false });
      continue;
    }

    if (row.valueEncrypted === null) {
      // DBの CHECK 制約で起きないはずの形。念のため使わない
      result.set(row.key, { ...base, value: null, unreadable: true });
      continue;
    }

    try {
      result.set(row.key, {
        ...base,
        value: decryptSettingValue(row.key, row.valueEncrypted).expose(),
        unreadable: false,
      });
    } catch (error) {
      if (!(error instanceof DecryptionError)) {
        throw error;
      }

      // **設定名だけを出す。** 暗号文も鍵もログへ出さない（SPEC 14.2）
      logger.error('設定を復号できなかった', { key: row.key });
      result.set(row.key, { ...base, value: null, unreadable: true });
    }
  }

  return result;
}

/** その名前がいまどこから来ているか */
export function sourceOf(
  stored: StoredSetting | undefined,
  envValue: string | undefined,
): SettingSource {
  if (stored !== undefined) {
    return stored.unreadable ? 'UNREADABLE' : 'DB';
  }

  return envValue === undefined || envValue.trim() === '' ? 'UNSET' : 'ENV';
}

/**
 * 実行時に使う設定の辞書を作る。
 *
 * `src/lib/ai/config.ts` の `AiConfigSource.env` や
 * `src/lib/mailer` の設定読み取りへ**そのまま渡せる形**で返す。
 * どちらも辞書を受け取る作りになっているため、読む側の作り替えは要らない。
 *
 * **サーバー専用。** 秘密の平文を含む。レスポンスへ入れない。
 */
export async function getRuntimeEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string | undefined>>> {
  const stored = await readStoredSettings();
  const merged: Record<string, string | undefined> = { ...base };

  for (const [key, setting] of stored) {
    if (setting.value !== null) {
      merged[key] = setting.value;
    }
  }

  return merged;
}
