'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';

/**
 * 管理画面の行き来（すべての画面の上に出る）。
 *
 * ## なぜ要ったか
 *
 * **画面から画面へ戻る道が無かった。** `/admin` に一覧はあるが、
 * 各画面には何も無く、**ブラウザの戻るしか無い。**
 * 10枚あって行き来するので、上に出しておく。
 *
 * ## いま居る場所を出す
 *
 * `aria-current="page"` を付ける。**色だけで示さない** —
 * 読み上げでも「いま居る場所」が分かるようにする。
 *
 * ## 並び順は使う順
 *
 * 上から**毎日見るもの → ときどき見るもの → 一度きりの設定**。
 * 名前の順に並べない（探すのは名前ではなく用事）。
 */

interface NavItem {
  href: Route;
  label: string;
}

export const ADMIN_NAV: readonly NavItem[] = [
  { href: '/admin' as Route, label: '入口' },
  { href: '/admin/users' as Route, label: 'モニター' },
  { href: '/admin/monitor-activity' as Route, label: '反応' },
  { href: '/admin/genres' as Route, label: 'ジャンル審査' },
  { href: '/admin/offer-catalog' as Route, label: '案件カタログ' },
  { href: '/admin/fact-issues' as Route, label: '事実の指摘' },
  { href: '/admin/jobs' as Route, label: 'ジョブ' },
  { href: '/admin/dashboard' as Route, label: '集計' },
  { href: '/admin/publish-pace' as Route, label: '公開ペース' },
  { href: '/admin/rich-menu' as Route, label: 'LINEのメニュー' },
  { href: '/admin/settings' as Route, label: '設定' },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="管理画面" className="overflow-x-auto">
      <ul className="flex items-center gap-1">
        {ADMIN_NAV.map((item) => {
          // **`/admin` だけは前方一致にしない。** 全部に一致してしまう
          const current =
            item.href === '/admin'
              ? pathname === '/admin'
              : pathname.startsWith(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`inline-block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                  current
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
