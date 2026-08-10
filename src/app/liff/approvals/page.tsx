'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  APPROVAL_TABS,
  APPROVAL_TAB_LABELS,
  approvalStatusLabel,
  approvalTabOf,
  type ApprovalTab,
} from '../_lib/approval-tabs';
import {
  ApprovalApiError,
  fetchApprovals,
  type ApprovalJson,
} from '../_lib/approvals-api';

/**
 * `/liff/approvals` 承認一覧（TASKS F-4、SPEC 6.1）。
 *
 * 完了条件は「**他ユーザーの承認を開けない**」。一覧はセッションの
 * ユーザーで絞られたものだけが返る（`/api/approvals`）。
 * **画面から他人のIDを指定する経路が無い。**
 *
 * ## 確認が要るものを先に示す
 *
 * 事実チェックの `WARNING` と表現の指摘は、**開く前に**行に出す。
 * 開いてから気づくより早く、どれに時間がかかるか分かる。
 */

/** タブの並びと件数 */
function useTabs(approvals: ApprovalJson[]) {
  return useMemo(() => {
    const grouped = new Map<ApprovalTab, ApprovalJson[]>(
      APPROVAL_TABS.map((tab) => [tab, []]),
    );

    for (const approval of approvals) {
      grouped.get(approvalTabOf(approval.status))?.push(approval);
    }

    return grouped;
  }, [approvals]);
}

export default function ApprovalListPage() {
  const [approvals, setApprovals] = useState<ApprovalJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ApprovalTab>('PENDING');

  useEffect(() => {
    let cancelled = false;

    void fetchApprovals().then(
      (result) => {
        if (!cancelled) setApprovals(result.approvals);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
            thrown instanceof ApprovalApiError
              ? thrown.message
              : '読み込めませんでした',
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useTabs(approvals ?? []);

  if (error !== null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  if (approvals === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const shown = grouped.get(tab) ?? [];

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">承認</h1>

      <div role="tablist" aria-label="承認の状態" className="mt-3 flex gap-2">
        {APPROVAL_TABS.map((entry) => {
          const count = grouped.get(entry)?.length ?? 0;

          return (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === tab}
              onClick={() => setTab(entry)}
              className={`rounded-full border px-3 py-1 text-xs ${
                entry === tab ? 'font-bold underline' : ''
              }`}
            >
              {APPROVAL_TAB_LABELS[entry]}
              {count > 0 ? ` ${count}` : ''}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed">
          {APPROVAL_TAB_LABELS[tab]}の提案はありません。
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {shown.map((approval) => (
            <li key={approval.id} className="rounded-lg border p-4">
              <Link
                href={`/liff/approvals/${approval.id}`}
                className="block"
                aria-label={`${approval.articleTitle} を確認`}
              >
                <p className="text-xs">{approval.blogName}</p>
                <p className="mt-1 text-base font-bold">
                  {approval.articleTitle}
                </p>
                <p className="mt-1 text-xs leading-relaxed">
                  {approval.proposalReason}
                </p>

                <p className="mt-2 text-xs">
                  {approvalStatusLabel(approval.status)}
                  {/* **確認が要ることを開く前に示す**（E-12・E-13） */}
                  {approval.factCheckStatus === 'WARNING'
                    ? '・未確認の事実あり'
                    : ''}
                  {approval.riskFlagCount > 0
                    ? `・表現の指摘 ${approval.riskFlagCount}件`
                    : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
