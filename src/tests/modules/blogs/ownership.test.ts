import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  BLOG_ERROR_CODES,
  notFoundError,
  ownedBy,
  requireFound,
} from '@/modules/blogs';

/**
 * 所有権ヘルパーの単体検証（B-3）。
 *
 * 実DBに対する検証は `src/tests/integration/blogs-ownership.test.ts`。
 */

describe('ownedBy', () => {
  it('id と userId の両方を条件に含める', () => {
    expect(ownedBy({ userId: 'u-1', id: 'b-1' })).toEqual({
      id: 'b-1',
      userId: 'u-1',
    });
  });

  // 空文字が条件に入ると、意図しない行に当たりうる
  it('空のIDを渡すと例外を投げる', () => {
    expect(() => ownedBy({ userId: '', id: 'b-1' })).toThrow();
    expect(() => ownedBy({ userId: 'u-1', id: '' })).toThrow();
  });
});

describe('notFoundError', () => {
  // 403 だと「そのIDは存在する」と伝わってしまう
  it('403 ではなく 404 を返す', () => {
    const error = notFoundError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(BLOG_ERROR_CODES.notFound);
  });

  it('メッセージに所有者の情報を含めない', () => {
    const message = notFoundError().message;

    expect(message).not.toMatch(/他人|他のユーザー|権限/);
  });
});

describe('requireFound', () => {
  it('値があればそのまま返す', () => {
    expect(requireFound({ id: 'b-1' })).toEqual({ id: 'b-1' });
  });

  it('null なら404を投げる', () => {
    expect(() => requireFound(null)).toThrow(AppError);
    expect(() => requireFound(null)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('0 や空文字は「見つかった」として扱う', () => {
    expect(requireFound(0)).toBe(0);
    expect(requireFound('')).toBe('');
  });
});
