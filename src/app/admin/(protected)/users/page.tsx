import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import {
  EMPTY_BLOG_COUNT,
  MAX_BLOGS_PER_USER,
  countBlogsByUserForAdmin,
  type AdminBlogCount,
} from '@/modules/blogs';
import {
  listMonitorsForAdmin,
  type AdminMonitorSummary,
  type OnboardingStatus,
} from '@/modules/users';

/**
 * `/admin/users` モニター一覧（TASKS B-7、SPEC 6.2）。
 *
 * 完了条件「モニター一覧とオンボーディング状況が表示される」。
 *
 * **招待・利用停止・サポート依頼は範囲外。** 前2つは操作であり完了条件に
 * 無い。サポート依頼は H-3 が作る。
 */

export const dynamic = 'force-dynamic';

const ONBOARDING_LABELS: Record<OnboardingStatus, string> = {
  NOT_STARTED: '未開始',
  IN_PROGRESS: '進行中',
  COMPLETED: '完了',
};

const USER_STATUS_LABELS: Record<AdminMonitorSummary['status'], string> = {
  INVITED: '招待済み',
  ACTIVE: '利用中',
  PAUSED: '停止中',
  WITHDRAWN: '退会',
};

/** 日付は年月日まで。時刻まで出しても運用の判断に使わない */
function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export default async function AdminUsersPage() {
  // レイアウトでも弾いているが、この画面は全ユーザーを横断して読むため
  // ここでも確認する（MODULE_RULES 5）。**レイアウトの判定だけに頼らない。**
  //
  // 理由を出すのはレイアウトの仕事なので、ここでは何も描かずに戻る。
  // 例外をそのまま投げると、拒否のたびにエラー境界へ落ちて
  // 未処理例外としてログに残る
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  const [monitors, blogCounts] = await Promise.all([
    listMonitorsForAdmin(),
    countBlogsByUserForAdmin(),
  ]);

  return (
    <div>
      <h1 className="text-lg font-bold">モニター</h1>
      <p className="mt-1 text-sm">{monitors.length} 名</p>

      {monitors.length === 0 ? (
        <p className="mt-6 text-sm">まだモニターが登録されていません。</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">モニター</th>
                <th className="p-2">状態</th>
                <th className="p-2">オンボーディング</th>
                <th className="p-2">同意</th>
                <th className="p-2">ブログ</th>
                <th className="p-2">登録日</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <MonitorRow
                  key={monitor.id}
                  monitor={monitor}
                  blogs={blogCounts[monitor.id] ?? EMPTY_BLOG_COUNT}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonitorRow({
  monitor,
  blogs,
}: {
  monitor: AdminMonitorSummary;
  blogs: AdminBlogCount;
}) {
  return (
    <tr className="border-b align-top">
      <td className="p-2">
        <p className="font-bold">{monitor.displayName}</p>
        {monitor.email === null ? null : (
          <p className="text-xs">{monitor.email}</p>
        )}
      </td>
      <td className="p-2">{USER_STATUS_LABELS[monitor.status]}</td>
      <td className="p-2">
        {monitor.onboardingStatus === null
          ? '未開始'
          : ONBOARDING_LABELS[monitor.onboardingStatus]}
      </td>
      <td className="p-2">
        <ConsentCell monitor={monitor} />
      </td>
      <td className="p-2">
        <BlogCell blogs={blogs} />
      </td>
      <td className="p-2">{formatDate(monitor.createdAt)}</td>
    </tr>
  );
}

/**
 * 同意の状況。
 *
 * **足りないものを名指しする。** 「未完了」とだけ出すと、どちらの同意で
 * 止まっているかを調べるために毎回SQLを叩くことになる。
 */
function ConsentCell({ monitor }: { monitor: AdminMonitorSummary }) {
  const missing: string[] = [];
  if (monitor.termsAcceptedAt === null) missing.push('規約');
  if (monitor.dataUseConsentAt === null) missing.push('データ利用');

  if (missing.length === 0) {
    return <span>済</span>;
  }

  return <span>未：{missing.join('・')}</span>;
}

/**
 * ブログの使用枠。
 *
 * **`CLOSED` を含めた使用枠を出す。** 閉じてもスロットは戻らないため
 * （Q-008）、稼働数だけを見ると「まだ枠が空いている」と誤読される。
 */
function BlogCell({ blogs }: { blogs: AdminBlogCount }) {
  return (
    <span>
      {blogs.open} / {MAX_BLOGS_PER_USER}
      {blogs.closed === 0 ? null : (
        <span className="text-xs">（終了 {blogs.closed}）</span>
      )}
    </span>
  );
}
