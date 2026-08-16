import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_NAV,
  AdminNav,
} from '@/app/admin/(protected)/_components/admin-nav';

/**
 * 管理画面の行き来。
 *
 * ## なぜ試験を置くか
 *
 * **画面から画面へ戻る道が無かった。** `/admin` に一覧はあるが、
 * 各画面には何も無く、**ブラウザの戻るしか無い**状態だった。
 *
 * 同じことは**画面を足したときに黙って起きる。** 新しい画面を作って
 * リンクを足し忘れると、**そこへは行けるが、そこから先が無い。**
 * ここで見張る。
 */

// **`import.meta.url` を使わない。** この試験は jsdom で動くため
// `file:` の URL にならない
const ADMIN_DIR = join(process.cwd(), 'src/app/admin/(protected)');

vi.mock('next/navigation', () => ({
  usePathname: (): string => mockPathname,
}));

let mockPathname = '/admin';

/**
 * `(protected)` の下にある画面を数える。
 *
 * `_components` のような**下線で始まるものは画面ではない**
 * （Next.js が経路にしない）。
 */
function pageDirectories(): string[] {
  return readdirSync(ADMIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => `/admin/${entry.name}`);
}

describe('行き先がそろっている', () => {
  /**
   * **画面を足したら、ここにも足す。** 足し忘れると、
   * その画面へ行く道がどこにも無くなる。
   */
  it('管理画面の全ページがナビに載っている', () => {
    const hrefs = new Set<string>(ADMIN_NAV.map((item) => item.href));
    const missing = pageDirectories().filter((path) => !hrefs.has(path));

    expect(missing).toEqual([]);
  });

  /** **逆も見る。** 消した画面へのリンクを残さない */
  it('ナビの行き先がすべて実在する', () => {
    const pages = new Set(['/admin', ...pageDirectories()]);
    const dangling = ADMIN_NAV.map((item) => item.href).filter(
      (href) => !pages.has(href),
    );

    expect(dangling).toEqual([]);
  });

  it('入口への行き先を持っている', () => {
    expect(ADMIN_NAV.map((item) => item.href)).toContain('/admin');
  });
});

describe('いま居る場所を出す', () => {
  /** **色だけで示さない。** 読み上げでも分かるようにする */
  it('開いている画面に aria-current を付ける', () => {
    mockPathname = '/admin/settings';
    render(<AdminNav />);

    expect(screen.getByRole('link', { name: '設定' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'モニター' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  /** 下の階層に居ても、その画面が「いま居る場所」 */
  it('画面の下の階層でも印が付く', () => {
    mockPathname = '/admin/users/abc';
    render(<AdminNav />);

    expect(screen.getByRole('link', { name: 'モニター' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  /**
   * **`/admin` を前方一致にしない。** すると全部の画面に一致して、
   * 「いま居る場所」が2つ出る。
   */
  it('入口は、入口に居るときだけ印が付く', () => {
    mockPathname = '/admin/jobs';
    render(<AdminNav />);

    expect(screen.getByRole('link', { name: '入口' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(
      screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });
});
