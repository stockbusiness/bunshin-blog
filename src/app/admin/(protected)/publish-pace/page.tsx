import { headers } from 'next/headers';
import { listAuditLogsForAdmin } from '@/modules/audit';
import { requireAdmin } from '@/modules/auth';
import { MIN_JUDGED_ARTICLES, MATURE_AFTER_DAYS } from '@/modules/analytics';
import {
  BackLink,
  EmptyState,
  Page,
  PageHeader,
  TD,
  TH,
  TableFrame,
} from '../_components/ui';

/**
 * `/admin/publish-pace` 公開ペースの調整履歴（TASKS G-8b、作業指示書 W-8）。
 *
 * 完了条件の「**調整の履歴を管理画面で確認できる**」。
 *
 * **専用のテーブルを作っていない。** 調整は**ブログに対する自動的な介入**で、
 * ADMIN の介入と同じ性質のもの。`audit_logs` から読む。
 *
 * **変わった回だけが並ぶ。** 見直しても変わらなかった回は記録していない
 * （記録すると、変わった回が埋もれる）。
 */

export const dynamic = 'force-dynamic';

/** 監査ログの `metadata` は jsonb。**形を確かめてから使う** */
interface Adjustment {
  decision: string;
  from: number;
  to: number;
  judged: number;
  indexed: number;
}

function readAdjustment(metadata: unknown): Adjustment | null {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const numbers = ['from', 'to', 'judged', 'indexed'] as const;

  if (
    typeof record['decision'] !== 'string' ||
    numbers.some((key) => typeof record[key] !== 'number')
  ) {
    return null;
  }

  return {
    decision: record['decision'],
    from: record['from'] as number,
    to: record['to'] as number,
    judged: record['judged'] as number,
    indexed: record['indexed'] as number,
  };
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  RAISE: '上限を上げた',
  STOP: '公開を止めた',
};

function formatAt(value: Date): string {
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function AdminPublishPacePage() {
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  const logs = (await listAuditLogsForAdmin({ entityType: 'blog' })).filter(
    (log) => log.action === 'PUBLISH_CAP_ADJUSTED',
  );

  return (
    <Page>
      <PageHeader
        title="公開ペースの調整"
        meta={`${String(logs.length)} 件`}
        lead={`公開から${String(MATURE_AFTER_DAYS)}日以上経った記事のインデックス率で、2週間ごとに見直しています。判定のある記事が${String(MIN_JUDGED_ARTICLES)}本に満たないブログは動かしません。変わった回だけが並びます。`}
      />

      {logs.length === 0 ? (
        <EmptyState>
          {/* **「問題なし」と書かない。** 測れていないだけかもしれない */}
          調整された記録はまだありません。
        </EmptyState>
      ) : (
        <TableFrame minWidth="44rem">
          <thead>
            <tr>
              <th className={TH}>日時</th>
              <th className={TH}>ブログ</th>
              <th className={TH}>判断</th>
              <th className={TH}>週の上限</th>
              <th className={TH}>インデックス</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const adjustment = readAdjustment(log.metadata);

              return (
                <tr key={log.id}>
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {formatAt(log.createdAt)}
                  </td>
                  <td className={`${TD} text-xs`}>{log.entityId ?? '—'}</td>
                  <td className={TD}>
                    {adjustment === null
                      ? '—'
                      : (DECISION_LABELS[adjustment.decision] ??
                        adjustment.decision)}
                  </td>
                  <td className={`${TD} whitespace-nowrap font-medium`}>
                    {adjustment === null
                      ? '—'
                      : `${String(adjustment.from)} → ${String(adjustment.to)} 本`}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {/* **率だけを出さない。** 5本中4本か100本中80本かで
                        読み方が変わる */}
                    {adjustment === null
                      ? '—'
                      : `${String(adjustment.indexed)} / ${String(adjustment.judged)} 本`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}

      <BackLink />
    </Page>
  );
}
