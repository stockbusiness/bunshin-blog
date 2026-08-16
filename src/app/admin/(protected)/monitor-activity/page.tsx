import { headers } from 'next/headers';
import {
  ACTIVITY_LABELS,
  ACTIVITY_WINDOW_DAYS,
  MIN_SENT_FOR_JUDGEMENT,
  countApprovalActivityForAdmin,
  judgeApprovalActivity,
  type ActivityVerdict,
} from '@/modules/approvals';
import { requireAdmin } from '@/modules/auth';
import { listMonitorsForAdmin } from '@/modules/users';
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
 * `/admin/monitor-activity` モニターが提案に反応しているか（TASKS J-5）。
 *
 * **Phase 0 で最も起きやすい失敗は「モニターが承認しない」。** 提案は
 * 届く、でも押されない。**画面には何も起きていないように見える。**
 *
 * ROADMAP は8週間継続率を見ることにしているが、**8週間は遅すぎる。**
 * ここは**14日**で見る。
 *
 * ## 送っていない人を「反応が悪い」にしない
 *
 * 提案が1件も届いていない人は、**Bunshin 側が止まっている**
 * （構成表・記事生成・通知のどこか）。**声をかける相手ではない。**
 */

export const dynamic = 'force-dynamic';

/** 手を打つ順に並べる。**放っておくと失われるものが上** */
const VERDICT_ORDER: Readonly<Record<ActivityVerdict, number>> = {
  NOTHING_SENT: 0,
  LOW_RESPONSE: 1,
  NOT_ENOUGH_DATA: 2,
  ACTIVE: 3,
};

/**
 * 色は**手を打つ順**に合わせる（`VERDICT_ORDER` と同じ並び）。
 *
 * **`NOTHING_SENT` を赤にする。** 声をかける相手ではなく、
 * **こちらが止まっている** — 放っておくと何日でも進まない。
 */
const ACTIVITY_TONES: Readonly<Record<ActivityVerdict, BadgeTone>> = {
  NOTHING_SENT: 'danger',
  LOW_RESPONSE: 'warn',
  NOT_ENOUGH_DATA: 'neutral',
  ACTIVE: 'ok',
};

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export default async function MonitorActivityPage() {
  await requireAdmin((await headers()).get('cookie'));

  // **期間の起点は `approvals` が作る。** 描画中に現在時刻を読むと
  // 副作用として弾かれる（`react-hooks/purity`）
  const [monitors, counts] = await Promise.all([
    listMonitorsForAdmin(),
    countApprovalActivityForAdmin(),
  ]);

  // **`ACTIVE` の利用者だけを見る。** 停止した人が「反応が無い」と
  // 並ぶと、手を打つべき人が埋もれる
  const rows = monitors
    .filter((monitor) => monitor.status === 'ACTIVE')
    .map((monitor) => {
      const count = counts.get(monitor.id) ?? { sent: 0, responded: 0 };

      return {
        id: monitor.id,
        displayName: monitor.displayName,
        ...count,
        ...judgeApprovalActivity(count),
      };
    })
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        (a.rate ?? 0) - (b.rate ?? 0),
    );

  return (
    <Page>
      <PageHeader
        title="モニターの反応"
        lead={
          <>
            直近 {ACTIVITY_WINDOW_DAYS} 日に<strong>送れた</strong>
            提案のうち、承認・見送り・修正依頼のいずれかが行われた割合です。
            <strong>見ただけは反応に数えません</strong>
            （開いて閉じたのは判断ではないため）。送信が
            {MIN_SENT_FOR_JUDGEMENT} 件に満たない人は判定しません。
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyState>参加中のモニターがいません。</EmptyState>
      ) : (
        <TableFrame minWidth="40rem">
          <thead>
            <tr>
              <th className={TH}>モニター</th>
              <th className={TH}>送った</th>
              <th className={TH}>反応した</th>
              <th className={TH}>割合</th>
              <th className={TH}>状態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className={`${TD} font-medium text-slate-900`}>
                  {row.displayName}
                </td>
                <td className={TD}>{row.sent}</td>
                <td className={TD}>{row.responded}</td>
                <td className={`${TD} font-medium`}>{formatRate(row.rate)}</td>
                <td className={TD}>
                  <Badge tone={ACTIVITY_TONES[row.verdict]}>
                    {ACTIVITY_LABELS[row.verdict]}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}

      <BackLink />
    </Page>
  );
}
