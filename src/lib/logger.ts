/**
 * 共通ロガー（TASKS A-4）。
 *
 * 秘密情報をログへ出力しない（SPEC 14.2、DATA_MODEL 7章）。
 * - 機密を示すフィールド名を持つ値はマスクする
 * - 文字列に埋め込まれた接続情報・Bearerトークンもマスクする
 *
 * マスクは「出し忘れ」を防ぐための最後の砦であり、機密を渡してよい
 * という意味ではない。呼び出し側は最初から渡さないこと。
 */

export const REDACTED = '[REDACTED]';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * この名前を含むフィールドはマスクする。
 *
 * DATA_MODEL 7章の暗号化対象（`*_encrypted`）と、SPEC 14.2 が env で持つと
 * 定めた秘密情報を対象にする。`keyword` `author` のような業務フィールドを
 * 巻き込まないよう、`key` `auth` 単体では一致させない。
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /credential/i,
  /^authorization$/i,
  /cookie/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /access[-_]?key/i,
  /encrypted/i,
  /database[-_]?url/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** `scheme://user:password@host` の資格情報部分を伏せる */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;

/** `Authorization: Bearer xxx` 相当の文字列 */
const BEARER_TOKEN = /\b(bearer|basic)\s+[\w\-._~+/]+=*/gi;

/** 文字列に埋め込まれた秘密情報を伏せる */
export function scrubString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`);
}

const MAX_DEPTH = 8;

function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(value.stack === undefined ? {} : { stack: scrubString(value.stack) }),
    };
  }

  if (depth >= MAX_DEPTH) {
    return '[MAX_DEPTH]';
  }

  if (seen.has(value as object)) {
    return '[CIRCULAR]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(source[key], depth + 1, seen);
  }
  return result;
}

/** 秘密情報をマスクした値を返す。元の値は変更しない */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 固定のフィールドを引き継いだ子ロガーを作る（request_id など） */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  /** 全ログに付与するフィールド */
  base?: Record<string, unknown>;
  /** テストで固定するための時刻取得 */
  now?: () => Date;
}

const consoleSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === 'error' || entry.level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
};

function defaultLevel(): LogLevel {
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const sink = options.sink ?? consoleSink;
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());

  function write(
    entryLevel: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) {
      return;
    }

    const merged = { ...base, ...fields };
    const entry: LogEntry = {
      timestamp: now().toISOString(),
      level: entryLevel,
      message: scrubString(message),
      ...(Object.keys(merged).length === 0
        ? {}
        : { fields: redact(merged) as Record<string, unknown> }),
    };

    sink(entry);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) =>
      createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** アプリケーション共通のロガー */
export const logger = createLogger();
