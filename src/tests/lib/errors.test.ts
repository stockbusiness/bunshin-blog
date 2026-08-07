import { describe, expect, it } from 'vitest';
import {
  AppError,
  INTERNAL_ERROR_MESSAGE,
  toErrorHttpResponse,
  toErrorResponse,
} from '@/lib/errors';
import { createLogger, REDACTED, type LogEntry } from '@/lib/logger';

function testLogger(): {
  entries: LogEntry[];
  logger: ReturnType<typeof createLogger>;
} {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: createLogger({ sink: (entry) => entries.push(entry) }),
  };
}

describe('AppError', () => {
  it('ファクトリがコードとステータスを対応させる', () => {
    expect(AppError.unauthorized().status).toBe(401);
    expect(AppError.unauthorized().code).toBe('UNAUTHORIZED');
    expect(AppError.forbidden().status).toBe(403);
    expect(AppError.notFound().status).toBe(404);
    expect(AppError.conflict('重複').status).toBe(409);
    expect(AppError.validationFailed().status).toBe(422);
    expect(AppError.rateLimited().status).toBe(429);
  });

  it('モジュール固有のコードを受け付ける', () => {
    const error = new AppError('WP_CANNOT_CREATE_POSTS', 403, '権限不足');

    expect(error.code).toBe('WP_CANNOT_CREATE_POSTS');
    expect(error.status).toBe(403);
  });
});

describe('toErrorResponse', () => {
  it('AppError はコードとメッセージをそのまま返す', () => {
    const { logger } = testLogger();
    const { status, body } = toErrorResponse(
      AppError.notFound('ブログが見つかりません'),
      { logger },
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('ブログが見つかりません');
  });

  it('requestId を本文に含める', () => {
    const { logger } = testLogger();
    const { body } = toErrorResponse(AppError.forbidden(), {
      logger,
      requestId: 'r-1',
    });

    expect(body.error.requestId).toBe('r-1');
  });

  // SPEC 14.2：クライアントへ秘密情報を返さない
  it('想定外の例外は 500 に丸め、元のメッセージを返さない', () => {
    const { logger } = testLogger();
    const { status, body } = toErrorResponse(
      new Error('connect ECONNREFUSED postgresql://admin:s3cr3t@db:5432'),
      { logger },
    );

    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(body)).not.toContain('s3cr3t');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('想定外の例外の詳細はサーバー側のログにのみ残す', () => {
    const { entries, logger } = testLogger();
    toErrorResponse(new Error('内部の詳細'), { logger });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
    expect(JSON.stringify(entries[0])).toContain('内部の詳細');
  });

  it('ログに出す cause の秘密情報はマスクする', () => {
    const { entries, logger } = testLogger();

    toErrorResponse(
      AppError.badRequest('接続に失敗', {
        cause: { app_password_encrypted: 'enc:should-not-appear' },
      }),
      { logger },
    );

    const output = JSON.stringify(entries);
    expect(output).not.toContain('should-not-appear');
    expect(output).toContain(REDACTED);
  });

  it('details に混ざった秘密情報はクライアントへも返さない', () => {
    const { logger } = testLogger();
    const { body } = toErrorResponse(
      AppError.validationFailed('入力エラー', {
        details: { field: 'site_url', app_password_encrypted: 'enc:leak' },
      }),
      { logger },
    );

    expect(JSON.stringify(body)).not.toContain('enc:leak');
    expect(body.error.details?.['field']).toBe('site_url');
  });

  it('4xx は warn、5xx は error でログする', () => {
    const { entries, logger } = testLogger();

    toErrorResponse(AppError.notFound(), { logger });
    toErrorResponse(new AppError('INTERNAL', 500, '内部'), { logger });

    expect(entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });
});

describe('toErrorHttpResponse', () => {
  it('JSON の Response を返す', async () => {
    const { logger } = testLogger();
    const response = toErrorHttpResponse(AppError.forbidden(), { logger });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });
});
