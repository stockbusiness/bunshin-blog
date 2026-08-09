import Link from 'next/link';
import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';

/**
 * `/admin` の入口（TASKS B-6）。
 *
 * **B-6 は「MONITORが `/admin` へアクセスできない」ことまで。**
 * SPEC 6.2 の `/admin/dashboard`（集計）は G-7。モニター一覧は B-7。
 * ここにその内容を作らない。
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
      </nav>

      <p className="mt-6 text-sm leading-relaxed">
        ダッシュボードは G-7 で追加します。
      </p>
    </div>
  );
}
