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
import { MonitorStatusActions } from './_components/monitor-status-actions';
import {
  Badge,
  BackLink,
  EmptyState,
  Page,
  PageHeader,
  TD,
  TH,
  TableFrame,
  type BadgeTone,
} from '../_components/ui';

/**
 * `/admin/users` モニター一覧（TASKS B-7、SPEC 6.2）。
 *
 * B-7 の完了条件「モニター一覧とオンボーディング状況が表示される」に、
 * H-1 で**状態を変える操作**を足した（SPEC 6.2 の「利用停止」と、
 * `INVITED` を `ACTIVE` にする承認）。
 *
 * **退会（`WITHDRAWN`）は置かない**（H-4）。戻せない操作を停止と同じ
 * 並びに置くと、停止のつもりで退会させる事故が起きる。
 * サポート依頼は H-3 が作る。
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

/**
 * 状態の色。
 *
 * **`INVITED` を目立たせる。** 承認しないと本人は何もできないまま
 * 待つことになり、**画面には何も起きていないように見える。**
 */
const USER_STATUS_TONES: Record<AdminMonitorSummary['status'], BadgeTone> = {
  INVITED: 'warn',
  ACTIVE: 'ok',
  PAUSED: 'neutral',
  WITHDRAWN: 'neutral',
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
    <Page>
      <PageHeader
        title="モニター"
        meta={`${String(monitors.length)} 名`}
        lead="参加の承認と停止を行います。退会はここに置いていません（停止のつもりで退会させる事故を防ぐため）。"
      />

      {monitors.length === 0 ? (
        <EmptyState>
          まだモニターが登録されていません。LINEで友だち追加して同意まで進むと、ここに出ます。
        </EmptyState>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <th className={TH}>モニター</th>
              <th className={TH}>状態</th>
              <th className={TH}>オンボーディング</th>
              <th className={TH}>同意</th>
              <th className={TH}>ブログ</th>
              <th className={TH}>登録日</th>
              <th className={TH}>操作</th>
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
        </TableFrame>
      )}

      <BackLink />
    </Page>
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
    <tr>
      <td className={TD}>
        <p className="font-bold text-slate-900">{monitor.displayName}</p>
        {monitor.email === null ? null : (
          <p className="text-xs text-slate-500">{monitor.email}</p>
        )}
      </td>
      <td className={TD}>
        <Badge tone={USER_STATUS_TONES[monitor.status]}>
          {USER_STATUS_LABELS[monitor.status]}
        </Badge>
      </td>
      <td className={TD}>
        {monitor.onboardingStatus === null
          ? '未開始'
          : ONBOARDING_LABELS[monitor.onboardingStatus]}
      </td>
      <td className={TD}>
        <ConsentCell monitor={monitor} />
      </td>
      <td className={TD}>
        <BlogCell blogs={blogs} />
      </td>
      <td className={`${TD} whitespace-nowrap text-xs`}>
        {formatDate(monitor.createdAt)}
      </td>
      <td className={TD}>
        <MonitorStatusActions
          userId={monitor.id}
          status={monitor.status}
          displayName={monitor.displayName}
        />
      </td>
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
    return <Badge tone="ok">済</Badge>;
  }

  return <Badge tone="warn">未：{missing.join('・')}</Badge>;
}

/**
 * ブログの使用枠。
 *
 * **`CLOSED` を含めた使用枠を出す。** 閉じてもスロットは戻らないため
 * （Q-008）、稼働数だけを見ると「まだ枠が空いている」と誤読される。
 */
function BlogCell({ blogs }: { blogs: AdminBlogCount }) {
  return (
    <span className="whitespace-nowrap">
      {blogs.open} / {MAX_BLOGS_PER_USER}
      {blogs.closed === 0 ? null : (
        <span className="text-xs text-slate-500">（終了 {blogs.closed}）</span>
      )}
    </span>
  );
}
