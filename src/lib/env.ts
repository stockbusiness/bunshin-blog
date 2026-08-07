import { z } from 'zod';

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
