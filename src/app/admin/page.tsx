import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';

/**
 * `/admin` の入口（TASKS B-6）。
 *
 * **B-6 は「MONITORが `/admin` へアクセスできない」ことまで。**
 * SPEC 6.2 の `/admin/dashboard`（集計）は G-7、モニター一覧は B-7。
 * ここにその内容を作らない。
 */
export default async function AdminHomePage() {
  // レイアウトで弾いているため、ここへ来るのは ADMIN のみ
  const admin = await requireAdmin((await headers()).get('cookie'));

  return (
    <div>
      <h1 className="text-lg font-bold">管理画面</h1>
      <p className="mt-2 text-sm">{admin.displayName} さん</p>
      <p className="mt-4 text-sm leading-relaxed">
        モニター一覧は B-7、ダッシュボードは G-7 で追加します。
      </p>
    </div>
  );
}
