import { headers } from 'next/headers';
import { listAuditLogsForAdmin } from '@/modules/audit';
import { requireAdmin } from '@/modules/auth';
import { MIN_JUDGED_ARTICLES, MATURE_AFTER_DAYS } from '@/modules/analytics';

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
    <div>
      <h1 className="text-lg font-bold">公開ペースの調整</h1>
      <p className="mt-1 text-sm leading-relaxed">
        公開から{MATURE_AFTER_DAYS}
        日以上経った記事のインデックス率で、2週間ごとに見直しています。
        判定のある記事が{MIN_JUDGED_ARTICLES}本に満たないブログは動かしません。
      </p>

      {logs.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed">
          {/* **「問題なし」と書かない。** 測れていないだけかもしれない */}
          調整された記録はまだありません。
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">日時</th>
                <th className="p-2">ブログ</th>
                <th className="p-2">判断</th>
                <th className="p-2">週の上限</th>
                <th className="p-2">インデックス</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const adjustment = readAdjustment(log.metadata);

                return (
                  <tr key={log.id} className="border-b align-top">
                    <td className="p-2 text-xs">{formatAt(log.createdAt)}</td>
                    <td className="p-2 text-xs">{log.entityId ?? '—'}</td>
                    <td className="p-2">
                      {adjustment === null
                        ? '—'
                        : (DECISION_LABELS[adjustment.decision] ??
                          adjustment.decision)}
                    </td>
                    <td className="p-2">
                      {adjustment === null
                        ? '—'
                        : `${String(adjustment.from)} → ${String(adjustment.to)} 本`}
                    </td>
                    <td className="p-2 text-xs">
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
          </table>
        </div>
      )}
    </div>
  );
}
