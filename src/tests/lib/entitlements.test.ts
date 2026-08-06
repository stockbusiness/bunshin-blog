import { describe, expect, it } from 'vitest';
import { CAPABILITIES, can, type Capability } from '@/lib/entitlements';

describe('can', () => {
  // Phase 0 は課金を実装しないため、全ての capability が通る
  it('全ての capability で true を返す', async () => {
    for (const capability of CAPABILITIES) {
      await expect(can('user-1', capability)).resolves.toBe(true);
    }
  });

  it('ユーザーが異なっても true を返す', async () => {
    await expect(can('user-1', 'blog.create')).resolves.toBe(true);
    await expect(can('user-2', 'blog.create')).resolves.toBe(true);
    await expect(can('', 'blog.create')).resolves.toBe(true);
  });

  it('Promise を返す', () => {
    expect(can('user-1', 'article.generate')).toBeInstanceOf(Promise);
  });
});

describe('Capability', () => {
  it('指示された capability を定義している', () => {
    expect(CAPABILITIES).toContain('blog.create');
    expect(CAPABILITIES).toContain('article.generate');
    expect(CAPABILITIES).toContain('video.generate');
  });

  it('重複した定義を持たない', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it('文字列リテラルのユニオン型である', () => {
    // 未定義の capability は型エラーになる（コンパイル時の確認）
    const valid: Capability = 'blog.create';
    // @ts-expect-error 定義外の capability は受け付けない
    const invalid: Capability = 'blog.destroy';

    expect(valid).toBe('blog.create');
    expect(invalid).toBe('blog.destroy');
  });
});
