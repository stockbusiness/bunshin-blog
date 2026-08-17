import { headers } from 'next/headers';
import {
  ACTIVITY_LABELS,
  ACTIVITY_WINDOW_DAYS,
  MIN_SENT_FOR_JUDGEMENT,
  RETENTION_END_DAY,
  RETENTION_START_DAY,
  countApprovalActivityForAdmin,
  countRetentionForAdmin,
  isRetentionEligible,
  judgeApprovalActivity,
  retentionWindow,
  summarizeRetention,
  type ActivityVerdict,
} from '@/modules/approvals';
import { requireAdmin } from '@/modules/auth';
import { listMonitorsForAdmin } from '@/modules/users';
import {
  Badge,
  BackLink,
  Card,
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
  const now = new Date();
  const [monitors, counts] = await Promise.all([
    listMonitorsForAdmin(),
    countApprovalActivityForAdmin(),
  ]);

  // **8週間継続率（SPEC 16.2、Q-043）。** 上の表とは別物で、
  // こちらは**利用者ごとに位置が違う固定期間**（移動窓だと集計日で率が動く）。
  //
  // **停止した人も分母に入れる。** 「やめた」は継続しなかったこと
  // そのものなので、外すと率が良く出る
  const windows = monitors
    .filter(
      (monitor): monitor is typeof monitor & { activatedAt: Date } =>
        monitor.activatedAt !== null &&
        isRetentionEligible(monitor.activatedAt, now),
    )
    .map((monitor) => ({
      userId: monitor.id,
      ...retentionWindow(monitor.activatedAt),
    }));

  const retentionCounts = await countRetentionForAdmin(windows);
  const retention = summarizeRetention(
    windows.map((window) => ({
      userId: window.userId,
      ...(retentionCounts.get(window.userId) ?? { sent: 0, decided: 0 }),
    })),
  );

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

      {/*
        **KPIは別に出す。** 上のリードは「直近14日」の話で、
        こちらは固定期間。**同じ表に混ぜると読み違える**
      */}
      <Card title="8週間継続率（SPEC 16.2）">
        <p className="text-xs leading-relaxed text-slate-600">
          利用開始から{' '}
          <strong>
            {RETENTION_START_DAY}日目〜{RETENTION_END_DAY}日目
          </strong>
          の14日間に、承認・修正依頼・見送りのいずれかを1件以上行った人を
          <strong>継続</strong>とします（Q-043）。
          <strong>8週間を過ぎた人だけが分母</strong>です。
        </p>

        {retention.eligible === 0 ? (
          <p className="mt-3 text-sm">まだ8週間を過ぎたモニターがいません。</p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-600">継続率</dt>
              <dd className="text-lg font-bold">
                {formatRate(retention.rate)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">継続／対象</dt>
              <dd className="text-lg font-bold">
                {retention.continued} / {retention.eligible}
              </dd>
            </div>
            <div>
              {/*
                **分母から外さない。** 外すと、ジョブ停止や通知障害による
                未活動が見えなくなる（別に数えて原因を分ける）
              */}
              <dt className="text-xs text-slate-600">提案が届かなかった人</dt>
              <dd className="text-lg font-bold">{retention.noProposal}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-600">届いた人の継続率</dt>
              <dd className="text-lg font-bold">
                {formatRate(retention.respondedRateAmongSent)}
              </dd>
            </div>
          </dl>
        )}

        {retention.noProposal === 0 ? null : (
          <p className="mt-3 text-xs leading-relaxed">
            <strong>
              提案が1件も届かなかった人が {retention.noProposal} 人います。
            </strong>
            この人たちは分母に入っています —
            <strong>声をかける相手ではなく、仕組み側を確かめてください</strong>
            （構成表・記事生成・通知のどこかが止まっています）。
          </p>
        )}
      </Card>

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
