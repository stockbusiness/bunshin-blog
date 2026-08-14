import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 同じ位置の動的セグメントに違う名前を使わない。
 *
 * **`next build` はこれを見つけない。** 見つかるのは本番サーバが
 * 起動して**最初のリクエストを受けたとき**で、そこから先は
 * `/` を含む**すべてのリクエストが 500 になる**。
 *
 * ```
 * Error: You cannot use different slug names for the same dynamic path
 *        ('blogId' !== 'id').
 * ```
 *
 * 実際に起きた。`/api/blogs/[blogId]/results`（G-5）と
 * `/api/blogs/[id]/...`（I-3 で追加）が同居し、**CI は緑のまま
 * 本番だけが全滅する**状態が2週間残っていた。
 *
 * **ビルドが見張らないので、ここで見張る。**
 */

const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url));

/** Route Group `(protected)` と Parallel Route `@slot` は経路に現れない */
function isTransparent(name: string): boolean {
  return name.startsWith('(') || name.startsWith('@');
}

function isDynamic(name: string): boolean {
  return name.startsWith('[') && name.endsWith(']');
}

/** `[id]` `[...slug]` `[[...slug]]` から名前だけを取り出す */
function slugName(segment: string): string {
  return segment.replace(/^\[+\.{0,3}/, '').replace(/\]+$/, '');
}

/**
 * 経路上の位置ごとに、使われている動的セグメントの名前を集める。
 *
 * **キーは「親の経路」。** Next.js が衝突と見なすのは
 * **同じ親の下**に違う名前が並んだときだけで、深さが同じでも
 * 親が違えば衝突しない（`/api/blogs/[blogId]` と
 * `/api/personas/[personaId]` は問題ない）。
 */
function collectSlugs(
  dir: string,
  routePath: string,
  found: Map<string, Map<string, string[]>>,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_components') {
      continue;
    }

    const child = `${dir}/${entry.name}`;

    if (isTransparent(entry.name)) {
      // 経路に現れないので親の経路のまま潜る
      collectSlugs(child, routePath, found);
      continue;
    }

    if (isDynamic(entry.name)) {
      const atThisPath = found.get(routePath) ?? new Map<string, string[]>();
      const name = slugName(entry.name);
      atThisPath.set(name, [
        ...(atThisPath.get(name) ?? []),
        `${routePath}/${entry.name}`,
      ]);
      found.set(routePath, atThisPath);
    }

    collectSlugs(child, `${routePath}/${entry.name}`, found);
  }
}

describe('動的セグメントの名前', () => {
  it('同じ親の下で違う名前を使っていない', () => {
    const found = new Map<string, Map<string, string[]>>();
    collectSlugs(APP_DIR, '', found);

    const conflicts = [...found.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([parent, names]) => ({
        parent: parent === '' ? '/' : parent,
        used: [...names.keys()].sort(),
      }));

    expect(conflicts).toEqual([]);
  });

  /**
   * **この見張りが本当に働くことを確かめる。**
   * 集め方を間違えていると、上のテストは何があっても通ってしまう。
   */
  it('動的セグメントを実際に見つけている', () => {
    const found = new Map<string, Map<string, string[]>>();
    collectSlugs(APP_DIR, '', found);

    expect(found.get('/api/blogs')?.has('blogId')).toBe(true);
    expect(found.get('/api/personas')?.has('personaId')).toBe(true);
  });
});
