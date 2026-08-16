import Link from 'next/link';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { AppError } from '@/lib/errors';
import { requireAdmin } from '@/modules/auth';
import { AdminNav } from './_components/admin-nav';
import { BUTTON } from './_components/ui';

/**
 * 認証が要る管理画面の共通レイアウト（TASKS B-6、SPEC 6.2）。
 *
 * **判定はサーバー側で行う。** クライアントで隠すだけでは、画面の中身も
 * データも取得できてしまう。ここで弾けば配下の画面は ADMIN 前提で書ける。
 *
 * `middleware.ts` を使わないのは、セッションの検証が `node:crypto` の
 * `timingSafeEqual` に依存しており（B-2）、Middleware の既定の実行環境で
 * 動かないため。
 *
 * **`/admin/login` はこのレイアウトの外に置く**（B-11）。ログイン前の
 * 画面をここに入れると、ログインするためにログインが要ることになる。
 * そのためルートグループ `(protected)` で分けている。
 */

export const metadata: Metadata = {
  title: 'BUNSHIN BLOG 管理',
};

/** Server Component で描画するため、リクエストごとに評価させる */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieHeader = (await headers()).get('cookie');

  try {
    await requireAdmin(cookieHeader);
  } catch (error) {
    return <AdminDenied error={error} />;
  }

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      {/*
        **上に貼り付ける。** 表の長い画面が多く、スクロールしたあとに
        行き来できないと、そのたびに上まで戻ることになる
      */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link
            href="/admin"
            className="text-sm font-bold tracking-tight text-slate-900"
          >
            BUNSHIN BLOG 管理
          </Link>
          <div className="min-w-0 flex-1">
            <AdminNav />
          </div>
        </div>
      </header>

      <main className="px-4 py-6">{children}</main>
    </div>
  );
}

/**
 * 入れなかったときの画面。
 *
 * **理由は「認証が必要」か「権限が無い」の2種類だけを出す。** それ以上を
 * 書くと、どのアカウントが存在するかを推測する材料になる。
 */
function AdminDenied({ error }: { error: unknown }) {
  const message =
    error instanceof AppError ? error.message : 'この画面は利用できません';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 p-6 text-center">
      <p className="text-base font-bold text-slate-900">管理画面</p>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-600">
        {message}
      </p>
      <Link href="/admin/login" className={`mt-6 ${BUTTON}`}>
        ログインする
      </Link>
    </main>
  );
}
