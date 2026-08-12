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
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-bold">モニターの反応</h1>

      <p className="mt-2 text-sm text-gray-600">
        直近 {ACTIVITY_WINDOW_DAYS} 日に<strong>送れた</strong>提案のうち、
        承認・見送り・修正依頼のいずれかが行われた割合。
        <strong>見ただけは反応に数えない</strong>
        （開いて閉じたのは判断ではない）。 送信が {MIN_SENT_FOR_JUDGEMENT}{' '}
        件に満たない人は判定しない。
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">
          参加中のモニターがいません。
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4">モニター</th>
                <th className="py-2 pr-4">送った</th>
                <th className="py-2 pr-4">反応した</th>
                <th className="py-2 pr-4">割合</th>
                <th className="py-2">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="py-2 pr-4">{row.displayName}</td>
                  <td className="py-2 pr-4">{row.sent}</td>
                  <td className="py-2 pr-4">{row.responded}</td>
                  <td className="py-2 pr-4">{formatRate(row.rate)}</td>
                  <td className="py-2">{ACTIVITY_LABELS[row.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
