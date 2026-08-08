import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  JOB_ERROR_CODES,
  assertIdempotencyKey,
  buildIdempotencyKey,
  matchesJobType,
} from '@/modules/jobs';

/**
 * 冪等性キーの組み立て（TASKS C-4、SPEC 7.3）。
 *
 * ここで守りたいのは**衝突しないこと**。同じキーになった2つのジョブは、
 * 後から積んだほうが黙って捨てられる（`enqueueJob` は既存を返す）。
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('buildIdempotencyKey', () => {
  it('種類を前置する', () => {
    expect(buildIdempotencyKey('WORDPRESS_POST', 'item-1')).toBe(
      'WORDPRESS_POST:item-1',
    );
  });

  it('同じ入力からは同じキーになる', () => {
    expect(buildIdempotencyKey('GA4_FETCH', 'blog-1', '2026-08-08')).toBe(
      buildIdempotencyKey('GA4_FETCH', 'blog-1', '2026-08-08'),
    );
  });

  // 対象が同じでも、種類が違えば別のジョブとして積まれる必要がある
  it('種類が違えば別のキーになる', () => {
    expect(buildIdempotencyKey('WORDPRESS_POST', 'item-1')).not.toBe(
      buildIdempotencyKey('WORDPRESS_SYNC', 'item-1'),
    );
  });

  it('対象を複数取れる', () => {
    expect(buildIdempotencyKey('GA4_FETCH', 'blog-1', '2026-08-08')).toBe(
      'GA4_FETCH:blog-1:2026-08-08',
    );
  });

  it('知らない種類を拒む', () => {
    expect(
      codeOf(() => buildIdempotencyKey('NOT_A_JOB' as 'GA4_FETCH', 'blog-1')),
    ).toBe(JOB_ERROR_CODES.unknownType);
  });

  it('対象が無ければ拒む', () => {
    expect(codeOf(() => buildIdempotencyKey('GA4_FETCH'))).toBe(
      JOB_ERROR_CODES.invalidIdempotencyKey,
    );
    expect(codeOf(() => buildIdempotencyKey('GA4_FETCH', ''))).toBe(
      JOB_ERROR_CODES.invalidIdempotencyKey,
    );
  });

  /**
   * **これを許すと衝突する。**
   * `['a:b', 'c']` と `['a', 'b:c']` は、素直に繋ぐと同じ文字列になる。
   */
  it.each([['a:b'], ['a b'], ['a\nb'], ['あ'], ['a/b'], ['a%3Ab']])(
    '区切り文字や空白を含む対象を拒む: %s',
    (part) => {
      expect(codeOf(() => buildIdempotencyKey('GA4_FETCH', part))).toBe(
        JOB_ERROR_CODES.invalidIdempotencyKey,
      );
    },
  );

  it('長すぎるキーを拒む', () => {
    const long = 'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH);

    expect(codeOf(() => buildIdempotencyKey('GA4_FETCH', long))).toBe(
      JOB_ERROR_CODES.invalidIdempotencyKey,
    );
  });

  it('UUIDを3つ繋いでも収まる', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

    expect(() =>
      buildIdempotencyKey('ARTICLE_REGENERATION', uuid, uuid, uuid),
    ).not.toThrow();
  });
});

describe('matchesJobType', () => {
  it('種類で始まるかを見る', () => {
    expect(matchesJobType('WORDPRESS_POST:item-1', 'WORDPRESS_POST')).toBe(
      true,
    );
    expect(matchesJobType('WORDPRESS_SYNC:item-1', 'WORDPRESS_POST')).toBe(
      false,
    );
  });

  // 前方一致だけで見ると `WORDPRESS_POSTX:...` を通してしまう
  it('区切り文字まで含めて見る', () => {
    expect(matchesJobType('WORDPRESS_POSTX:item-1', 'WORDPRESS_POST')).toBe(
      false,
    );
  });
});

describe('assertIdempotencyKey', () => {
  it('組み立てたキーを通す', () => {
    expect(() =>
      assertIdempotencyKey(
        'WORDPRESS_POST',
        buildIdempotencyKey('WORDPRESS_POST', 'item-1'),
      ),
    ).not.toThrow();
  });

  it('種類が前置されていないキーを拒む', () => {
    expect(codeOf(() => assertIdempotencyKey('WORDPRESS_POST', 'item-1'))).toBe(
      JOB_ERROR_CODES.invalidIdempotencyKey,
    );
  });

  it('別の種類のキーを拒む', () => {
    expect(
      codeOf(() =>
        assertIdempotencyKey('WORDPRESS_POST', 'WORDPRESS_SYNC:item-1'),
      ),
    ).toBe(JOB_ERROR_CODES.invalidIdempotencyKey);
  });

  it('対象が空のキーを拒む', () => {
    expect(
      codeOf(() => assertIdempotencyKey('WORDPRESS_POST', 'WORDPRESS_POST:')),
    ).toBe(JOB_ERROR_CODES.invalidIdempotencyKey);
  });

  it('長すぎるキーを拒む', () => {
    const key = `WORDPRESS_POST:${'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH)}`;

    expect(codeOf(() => assertIdempotencyKey('WORDPRESS_POST', key))).toBe(
      JOB_ERROR_CODES.invalidIdempotencyKey,
    );
  });
});
