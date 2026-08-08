import { describe, expect, it } from 'vitest';
import {
  REDIRECT_CODE_LENGTH,
  generateRedirectCode,
  isRedirectCode,
} from '@/modules/affiliate';

/**
 * リダイレクタのコード（TASKS D-8）。
 *
 * `/go/<code>` は**認証が無い入口**で、当たれば飛び先が分かる。
 * **総当たりで引き当てられない値**であることが要る。
 */

describe('generateRedirectCode', () => {
  it('決めた長さで作る', () => {
    expect(generateRedirectCode()).toHaveLength(REDIRECT_CODE_LENGTH);
  });

  it('URLで意味を持つ文字を含まない', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateRedirectCode()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  /** 連番や content_item_id から作ると、1つ知られただけで他も引ける */
  it('毎回違う値になる', () => {
    const codes = new Set(
      Array.from({ length: 500 }, () => generateRedirectCode()),
    );

    expect(codes.size).toBe(500);
  });
});

describe('isRedirectCode', () => {
  it('作ったコードを通す', () => {
    expect(isRedirectCode(generateRedirectCode())).toBe(true);
  });

  it.each([
    ['短すぎる', 'abc'],
    ['長すぎる', 'a'.repeat(REDIRECT_CODE_LENGTH + 1)],
    ['空', ''],
    ['記号入り', `${'a'.repeat(REDIRECT_CODE_LENGTH - 1)}/`],
    ['スラッシュ', 'a'.repeat(REDIRECT_CODE_LENGTH - 2) + '..'],
  ])('%s を弾く（%s）', (_label, value) => {
    expect(isRedirectCode(value)).toBe(false);
  });
});
