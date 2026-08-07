import { describe, expect, it } from 'vitest';
import {
  createLogger,
  redact,
  scrubString,
  REDACTED,
  type LogEntry,
} from '@/lib/logger';

function collect(): { entries: LogEntry[]; sink: (entry: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

describe('redact', () => {
  // DATA_MODEL 7章：暗号化対象のフィールド名はマスクする
  it('DATA_MODEL 7章の暗号化フィールドをマスクする', () => {
    const result = redact({
      wp_username_encrypted: 'enc:aaa',
      app_password_encrypted: 'enc:bbb',
      refresh_token_encrypted: 'enc:ccc',
    }) as Record<string, unknown>;

    expect(result['wp_username_encrypted']).toBe(REDACTED);
    expect(result['app_password_encrypted']).toBe(REDACTED);
    expect(result['refresh_token_encrypted']).toBe(REDACTED);
    expect(JSON.stringify(result)).not.toContain('enc:');
  });

  it('秘密情報を示すフィールド名をマスクする', () => {
    const result = redact({
      password: 'pw-1',
      channelSecret: 'sc-1',
      accessToken: 'tk-1',
      apiKey: 'ak-1',
      api_key: 'ak-2',
      DATABASE_URL: 'postgresql://u:p@h/db',
      authorization: 'Bearer abc',
      cookie: 'sid=1',
      credentials: 'cr-1',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe(REDACTED);
    }
  });

  // 業務フィールドを巻き込むと、事故調査に必要な情報まで消える
  it('keyword や author など業務フィールドはマスクしない', () => {
    const result = redact({
      primary_keyword: '格安SIM 比較',
      keywords: ['a', 'b'],
      author: 'tanaka',
      authorId: 'u-1',
      monkey: 'not-a-key',
    }) as Record<string, unknown>;

    expect(result['primary_keyword']).toBe('格安SIM 比較');
    expect(result['keywords']).toEqual(['a', 'b']);
    expect(result['author']).toBe('tanaka');
    expect(result['authorId']).toBe('u-1');
    expect(result['monkey']).toBe('not-a-key');
  });

  it('入れ子と配列の中もマスクする', () => {
    const result = redact({
      blog: {
        id: 'b-1',
        connection: { site_url: 'https://ex.jp', app_password_encrypted: 'x' },
      },
      jobs: [{ id: 'j-1', input: { secret: 'shhh' } }],
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain('shhh');
    expect(json).toContain('https://ex.jp');
    expect(json).toContain('b-1');
  });

  it('元のオブジェクトを変更しない', () => {
    const original = { password: 'pw-1', id: 'u-1' };
    redact(original);

    expect(original.password).toBe('pw-1');
  });

  it('循環参照でも例外を投げない', () => {
    const node: Record<string, unknown> = { id: 'n-1' };
    node['self'] = node;

    expect(() => redact(node)).not.toThrow();
    expect(JSON.stringify(redact(node))).toContain('[CIRCULAR]');
  });

  it('Error は name と message を残しつつ内容をマスクする', () => {
    const error = new Error('接続失敗 postgresql://user:pw@localhost/db');
    const result = redact({ cause: error }) as Record<string, unknown>;
    const cause = result['cause'] as Record<string, unknown>;

    expect(cause['name']).toBe('Error');
    expect(String(cause['message'])).not.toContain('pw@');
    expect(String(cause['message'])).toContain(REDACTED);
  });
});

describe('scrubString', () => {
  it('接続文字列の資格情報をマスクする', () => {
    const result = scrubString('postgresql://admin:s3cr3t@db:5432/bunshin');

    expect(result).not.toContain('s3cr3t');
    expect(result).not.toContain('admin');
    expect(result).toContain('db:5432/bunshin');
  });

  it('Bearer トークンをマスクする', () => {
    const result = scrubString('Authorization: Bearer eyJhbGciOi.abc123');

    expect(result).not.toContain('eyJhbGciOi.abc123');
    expect(result).toContain(REDACTED);
  });
});

describe('createLogger', () => {
  it('レベル・メッセージ・フィールドを構造化して出す', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ sink, now: () => new Date(0) });

    logger.info('ジョブ開始', { jobId: 'j-1' });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('info');
    expect(entries[0]?.message).toBe('ジョブ開始');
    expect(entries[0]?.fields).toEqual({ jobId: 'j-1' });
    expect(entries[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });

  // A-4 完了条件：秘密情報がログに出ないことをテストで確認
  it('フィールドの秘密情報を出力しない', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ sink });

    logger.error('WordPress接続に失敗', {
      blogId: 'b-1',
      app_password_encrypted: 'enc:should-not-appear',
      channelSecret: 'should-not-appear-2',
    });

    const output = JSON.stringify(entries);
    expect(output).not.toContain('should-not-appear');
    expect(output).not.toContain('should-not-appear-2');
    expect(output).toContain('b-1');
  });

  it('メッセージ本文に混ざった秘密情報も出力しない', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ sink });

    logger.error('接続失敗: postgresql://admin:s3cr3t@db:5432/bunshin');

    expect(JSON.stringify(entries)).not.toContain('s3cr3t');
  });

  it('設定より低いレベルは出力しない', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ sink, level: 'warn' });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('child が固定フィールドを引き継ぎ、マスクも効く', () => {
    const { entries, sink } = collect();
    const logger = createLogger({ sink }).child({ requestId: 'r-1' });

    logger.info('処理中', { password: 'pw' });

    expect(entries[0]?.fields).toEqual({
      requestId: 'r-1',
      password: REDACTED,
    });
  });
});
