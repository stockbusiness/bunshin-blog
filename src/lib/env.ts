import { z } from 'zod';
import { isValidEncryptionKey } from '@/lib/crypto/key-format';

/**
 * サーバー側の環境変数を検証する。
 *
 * 追加のルール（TASKS A-3）:
 * - 変数は「それを使うタスク」で追加する。未実装機能の変数を先回りして
 *   宣言しない。例：LINEチャネルシークレットは F-2、暗号化キーは C-1。
 * - エラーメッセージには変数名と理由のみを出す。値は決して含めない
 *   （SPEC 14.2「ログへ秘密情報を出力しない」）。
 */
const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  /** PostgreSQL接続文字列。prisma/schema.prisma の datasource が参照する */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgresql://') || value.startsWith('postgres://'),
      { message: 'postgresql:// または postgres:// で始まる必要があります' },
    ),

  /**
   * LINE Login チャネルID（B-1）。
   *
   * LIFF の IDトークン検証で `client_id` として送り、`aud` の一致確認にも使う。
   * 数字のみのID。チャネルシークレットではないため秘密ではないが、
   * 環境ごとに変わるため環境変数で持つ。
   */
  LINE_LOGIN_CHANNEL_ID: z
    .string()
    .min(1)
    .refine((value) => /^\d+$/.test(value), {
      message: '数字のみのチャネルIDである必要があります',
    }),

  /**
   * セッションCookieの署名鍵（B-2）。
   *
   * 32文字以上を要求する。短い鍵はHMACの総当たりを現実的にする。
   * 環境ごとに別の値を使い、本番の値をリポジトリへ入れない（SPEC 14.2）。
   */
  SESSION_SECRET: z
    .string()
    .min(32, { message: '32文字以上である必要があります' }),

  /**
   * 保存データの暗号化キー（C-1、SPEC 5.4・14.2）。
   *
   * AES-256-GCM の鍵。base64 の32バイト。生成例: `openssl rand -base64 32`
   *
   * WordPress の認証情報と Google の refresh token を暗号化する
   * （DATA_MODEL 7章）。**鍵を変えると保存済みの値を復号できなくなる。**
   */
  ENCRYPTION_KEY: z.string().refine(isValidEncryptionKey, {
    message: 'base64 で32バイト（openssl rand -base64 32）である必要があります',
  }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** 環境変数の検証に失敗したことを表す。欠落・不正の変数名を保持する */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  /** 未設定だった変数名 */
  readonly missing: readonly string[];

  /** 設定されているが値が不正だった変数名 */
  readonly invalid: readonly string[];

  constructor(message: string, missing: string[], invalid: string[]) {
    super(message);
    this.missing = missing;
    this.invalid = invalid;
  }
}

type EnvSource = Record<string, string | undefined>;

function isUnset(source: EnvSource, name: string): boolean {
  const value = source[name];
  return value === undefined || value.trim() === '';
}

function buildMessage(missing: string[], invalid: string[]): string {
  const lines = ['環境変数の検証に失敗しました。'];

  if (missing.length > 0) {
    lines.push('', '未設定の環境変数:');
    for (const name of missing) {
      lines.push(`  - ${name}`);
    }
  }

  if (invalid.length > 0) {
    lines.push('', '値が不正な環境変数:');
    for (const name of invalid) {
      lines.push(`  - ${name}`);
    }
  }

  lines.push(
    '',
    '.env.example を参照して .env を設定してください。',
    '（値は表示しません。設定漏れの変数名のみを出しています）',
  );

  return lines.join('\n');
}

/**
 * 環境変数を検証して返す。副作用を持たないため、テストから任意の
 * ソースを渡して検証できる。
 *
 * @throws {EnvValidationError} 未設定または不正な変数がある場合
 */
export function parseServerEnv(source: EnvSource = process.env): ServerEnv {
  // 空文字は未設定として扱う。`FOO=` のような行を通さないため
  const normalized: EnvSource = {};
  for (const key of Object.keys(serverEnvSchema.shape)) {
    if (!isUnset(source, key)) {
      normalized[key] = source[key];
    }
  }

  const result = serverEnvSchema.safeParse(normalized);
  if (result.success) {
    return result.data;
  }

  const missing = new Set<string>();
  const invalid = new Set<string>();

  for (const issue of result.error.issues) {
    const name = issue.path.map(String).join('.');
    if (name === '') {
      continue;
    }
    if (isUnset(source, name)) {
      missing.add(name);
    } else {
      invalid.add(name);
    }
  }

  const missingNames = [...missing].sort();
  const invalidNames = [...invalid].sort();

  throw new EnvValidationError(
    buildMessage(missingNames, invalidNames),
    missingNames,
    invalidNames,
  );
}

let cached: ServerEnv | undefined;

/**
 * 検証済みの環境変数を返す。初回呼び出しで検証し、以降はキャッシュを返す。
 * 未設定があればここで例外を投げ、起動を失敗させる。
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv();
  return cached;
}

/** テスト用。キャッシュを破棄する */
export function resetServerEnvCache(): void {
  cached = undefined;
}
