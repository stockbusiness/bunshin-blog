/**
 * 管理画面から設定できる項目の一覧（TASKS H-7、OPEN_QUESTIONS Q-017）。
 *
 * **ここに無い名前は保存できない。** 任意の名前を受け取れるようにすると、
 * 管理画面が「アプリの環境変数を何でも書き換えられる入口」になる。
 *
 * ## 何を置けて、何を置けないか
 *
 * 置けるのは**アプリが動いた後で初めて要るもの**だけ。設定はDBにあり、
 * DBを読むには設定が要る（Q-017）。
 *
 * | 環境変数のまま | 理由 |
 * |---|---|
 * | `DATABASE_URL` | これが無いと設定そのものを読めない |
 * | `ENCRYPTION_KEY` | 保存された秘密を復号する鍵 |
 * | `SESSION_SECRET` | 管理画面へ入るための認証に要る |
 * | `APP_BASE_URL` | 管理者ログインのリンクを組み立てる。画面へ入る前に要る |
 * | `NEXT_PUBLIC_*` | ブラウザ向けはビルド時に埋め込まれる。DBに置いても効かない |
 *
 * ## 使う側が無い設定を置かない
 *
 * A-3 の方針（「変数はそれを使うタスクで追加する」）に従う。LINE Messaging API
 * のトークンは**F-2 で足す** — 読む処理が無いうちに項目だけ出すと、
 * 設定したのに何も起きない状態を作る。
 */

import { z } from 'zod';

export type SettingGroup = 'AI' | 'MAIL' | 'LINE';

export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
  AI: 'AI（生成）',
  MAIL: 'メール送信',
  LINE: 'LINE通知',
};

export interface SettingDefinition {
  key: string;
  group: SettingGroup;
  label: string;
  /** 画面に出す一行の説明 */
  description: string;
  /**
   * 秘密かどうか。
   *
   * `true` なら暗号化して保存し、**保存後は読み返せない**（末尾4文字だけ表示）。
   */
  secret: boolean;
  /** 入力値の検証。整えた値を返す */
  schema: z.ZodType<string>;
  /**
   * 選べる値。決まっているものだけ持つ。
   *
   * **画面が `catalog.ts` を読まなくて済むように持たせる。** ここは
   * サーバー専用モジュールの一部で、ブラウザ向けのコードから
   * import できない（MODULE_RULES 4）。
   */
  choices?: readonly string[] | undefined;
}

/** 空でない文字列。前後の空白は落とす */
const text = z.string().trim().min(1, { message: '空にできません' });

/** 正の数。単価と予算に使う */
const positiveNumber = text.refine(
  (value) => Number.isFinite(Number(value)) && Number(value) > 0,
  { message: '0より大きい数で入力してください' },
);

/** `true` / `false` のみ。曖昧な値で挙動が変わると原因が分かりにくい */
const FLAG_CHOICES = ['true', 'false'] as const;
const flag = z.enum(FLAG_CHOICES);

const mailAddress = text.refine(
  (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  { message: 'メールアドレスの形式で入力してください' },
);

/**
 * `https://` のURL。
 *
 * **`http://` を許さない。** 通知のボタンから開く先で、
 * 途中で書き換えられると別のページへ誘導できる。
 */
const httpsUrl = text.refine(
  (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'https:// のURLを入力してください' },
);

/**
 * 設定できる項目。**この配列が唯一の正。**
 *
 * 既定値はここに置かない。未設定なら解決順が環境変数・コード既定へ落ちる
 * （既定値の置き場所は `src/lib/ai/config.ts` のまま。二重管理を避ける）。
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'AI_PROVIDER',
    group: 'AI',
    label: 'プロバイダー',
    description: '未設定なら anthropic。いまは anthropic のみ動きます',
    secret: false,
    schema: z.enum(['anthropic', 'openai']),
    choices: ['anthropic', 'openai'],
  },
  {
    key: 'ANTHROPIC_API_KEY',
    group: 'AI',
    label: 'Anthropic APIキー',
    description: '保存すると読み返せません。差し替えは上書きで行います',
    secret: true,
    schema: text.min(8, { message: 'APIキーが短すぎます' }),
  },
  {
    key: 'AI_MODEL_LOW',
    group: 'AI',
    label: 'モデル（低）',
    description: '分類など軽い用途。未設定ならコードの既定値',
    secret: false,
    schema: text,
  },
  {
    key: 'AI_MODEL_STANDARD',
    group: 'AI',
    label: 'モデル（標準）',
    description: '記事本文など。未設定ならコードの既定値',
    secret: false,
    schema: text,
  },
  {
    key: 'AI_MODEL_HIGH',
    group: 'AI',
    label: 'モデル（高）',
    description: '比較記事など。未設定ならコードの既定値',
    secret: false,
    schema: text,
  },
  {
    key: 'AI_PRICE_LOW_INPUT',
    group: 'AI',
    label: '単価 低・入力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_PRICE_LOW_OUTPUT',
    group: 'AI',
    label: '単価 低・出力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_PRICE_STANDARD_INPUT',
    group: 'AI',
    label: '単価 標準・入力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_PRICE_STANDARD_OUTPUT',
    group: 'AI',
    label: '単価 標準・出力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_PRICE_HIGH_INPUT',
    group: 'AI',
    label: '単価 高・入力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_PRICE_HIGH_OUTPUT',
    group: 'AI',
    label: '単価 高・出力',
    description: '100万トークンあたりのUSD',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_BUDGET_USER_MONTHLY_USD',
    group: 'AI',
    label: '月間予算（利用者ごと）',
    description: '80% / 100% / 150% で ADMIN へ通知します',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_BUDGET_BLOG_MONTHLY_USD',
    group: 'AI',
    label: '月間予算（ブログごと）',
    description: '同上',
    secret: false,
    schema: positiveNumber,
  },
  {
    key: 'AI_BUDGET_STOP_ON_EXCEEDED',
    group: 'AI',
    label: '予算超過で生成を止める',
    description:
      'Phase 0 は false のまま。止めると検証データが欠落します（SPEC 12.2）',
    secret: false,
    schema: flag,
    choices: FLAG_CHOICES,
  },
  {
    key: 'AI_BUDGET_DOWNGRADE_ON_EXCEEDED',
    group: 'AI',
    label: '予算超過で低価格モデルへ落とす',
    description: '同上。既定は false',
    secret: false,
    schema: flag,
    choices: FLAG_CHOICES,
  },
  {
    key: 'RESEND_API_KEY',
    group: 'MAIL',
    label: 'Resend APIキー',
    description: '管理者ログインのリンク送信に使います。読み返せません',
    secret: true,
    schema: text.min(8, { message: 'APIキーが短すぎます' }),
  },
  {
    key: 'MAIL_FROM',
    group: 'MAIL',
    label: '送信元アドレス',
    description: 'Resend で認証済みのドメインのアドレス',
    secret: false,
    schema: mailAddress,
  },
  {
    key: 'LINE_CHANNEL_ACCESS_TOKEN',
    group: 'LINE',
    label: 'Messaging API チャネルアクセストークン',
    description: '記事の提案をLINEへ送るために使います。読み返せません（F-2）',
    secret: true,
    schema: text.min(20, { message: 'トークンが短すぎます' }),
  },
  {
    key: 'LIFF_BASE_URL',
    group: 'LINE',
    label: 'LIFF のURL',
    description:
      '通知の「内容を確認」ボタンの飛び先。例: https://liff.line.me/1234567890-abcdefgh',
    secret: false,
    schema: httpsUrl,
  },
  {
    key: 'ADMIN_ALERT_EMAIL',
    group: 'MAIL',
    label: '通知の宛先',
    description: '予算が80% / 100% / 150%に達したときの送り先（E-15）',
    secret: false,
    schema: mailAddress,
  },
];

const BY_KEY = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** 設定できる名前か。**ここに無い名前は保存も削除もしない** */
export function findSettingDefinition(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function isSettingKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** 秘密として扱う名前か。保存先の列が変わる */
export function isSecretSetting(key: string): boolean {
  return BY_KEY.get(key)?.secret === true;
}

/** 設定できる名前の一覧（定義の順） */
export function settingKeys(): readonly string[] {
  return SETTING_DEFINITIONS.map((definition) => definition.key);
}
