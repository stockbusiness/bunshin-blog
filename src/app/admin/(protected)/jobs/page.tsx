import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { MAX_ATTEMPTS, listFailedJobsForAdmin } from '@/modules/jobs';
import { JobRetryButton } from './_components/job-retry-button';
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
 * `/admin/jobs` 失敗したジョブ（TASKS H-14、SPEC 6.2・13.7）。
 *
 * **失敗したものだけを出す。** 動いているジョブを並べても押せるボタンが
 * 無く、探す邪魔になる。
 *
 * **入力と出力は出さない。** 記事本文も認証情報も入りうる（SPEC 14.2）。
 * どのジョブが、いつ、どんな理由で落ちたかが分かれば足りる。
 *
 * **止まっているものが無いことを「問題なし」と書かない** — 一覧が空でも、
 * ジョブが動いているかまでは分からない。
 */

export const dynamic = 'force-dynamic';

/** 日付は分まで。ジョブは同じ日に何度も動く */
function formatAt(value: Date | null): string {
  return value === null
    ? '—'
    : value.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function AdminJobsPage() {
  // レイアウトでも弾いているが、この画面は全ユーザーを横断して読むため
  // ここでも確認する（MODULE_RULES 5）
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  const jobs = await listFailedJobsForAdmin();

  return (
    <Page>
      <PageHeader
        title="失敗したジョブ"
        meta={`${String(jobs.length)} 件`}
        lead={`${String(MAX_ATTEMPTS)}回試して失敗したものだけが並びます。積み直すと、もう一度はじめから走ります。`}
      />

      {jobs.length === 0 ? (
        <EmptyState>
          積み直せるジョブはありません。
          <br />
          <strong>これは「問題なし」ではありません</strong>—
          ジョブが動いているかまでは、ここでは分かりません。
        </EmptyState>
      ) : (
        <TableFrame minWidth="52rem">
          <thead>
            <tr>
              <th className={TH}>種類</th>
              <th className={TH}>対象</th>
              <th className={TH}>理由</th>
              <th className={TH}>試行</th>
              <th className={TH}>失敗した時刻</th>
              <th className={TH}>操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td
                  className={`${TD} font-bold whitespace-nowrap text-slate-900`}
                >
                  {job.jobType}
                </td>
                <td className={`${TD} text-xs`}>
                  {/* **IDだけを出す。** 名前を引くと、この画面のために
                      全モジュールを横断して読むことになる */}
                  {job.blogId === null ? '—' : `blog: ${job.blogId}`}
                  {job.targetId === null ? null : (
                    <>
                      <br />
                      {`target: ${job.targetId}`}
                    </>
                  )}
                </td>
                <td className={TD}>
                  <p className="text-xs font-bold text-red-700">
                    {job.errorCode ?? '—'}
                  </p>
                  <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-600">
                    {job.errorMessage ?? ''}
                  </p>
                </td>
                <td className={TD}>{job.attemptCount}</td>
                <td className={`${TD} whitespace-nowrap text-xs`}>
                  {formatAt(job.completedAt)}
                </td>
                <td className={TD}>
                  <JobRetryButton jobId={job.id} jobType={job.jobType} />
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
