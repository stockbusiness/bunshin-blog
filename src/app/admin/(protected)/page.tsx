import Link from 'next/link';
import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';

/**
 * `/admin` の入口（TASKS B-6）。
 *
 * **B-6 は「MONITORが `/admin` へアクセスできない」ことまで。**
 * SPEC 6.2 の `/admin/dashboard`（集計）は G-7、モニター一覧は B-7 に置く。
 * ここは入口の一覧に徹する。
 */
export default async function AdminHomePage() {
  // **レイアウトの判定だけに頼らない**（B-6）。理由の表示はレイアウトの
  // 仕事なので、ここでは何も描かずに戻る。例外をそのまま投げると
  // 拒否のたびにエラー境界へ落ち、未処理例外としてログに残る
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  return (
    <div>
      <h1 className="text-lg font-bold">管理画面</h1>
      <p className="mt-2 text-sm">{admin.displayName} さん</p>
      <nav className="mt-6 flex flex-col gap-2">
        <Link href="/admin/users" className="text-sm underline">
          モニター一覧
        </Link>
        <Link href="/admin/settings" className="text-sm underline">
          設定（APIキー・接続テスト）
        </Link>
        <Link href="/admin/genres" className="text-sm underline">
          ジャンルの審査（段7）
        </Link>
        <Link href="/admin/rich-menu" className="text-sm underline">
          LINEのメニュー
        </Link>
        <Link href="/admin/dashboard" className="text-sm underline">
          実験の集計（ジャンル別・戦略別・ブログ別）
        </Link>
      </nav>
    </div>
  );
}
