import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { MAX_ATTEMPTS, listFailedJobsForAdmin } from '@/modules/jobs';
import { JobRetryButton } from './_components/job-retry-button';

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
    <div>
      <h1 className="text-lg font-bold">失敗したジョブ</h1>
      <p className="mt-1 text-sm">
        {jobs.length} 件（{MAX_ATTEMPTS}回試して失敗したもの）
      </p>

      {jobs.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed">
          積み直せるジョブはありません。
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">種類</th>
                <th className="p-2">対象</th>
                <th className="p-2">理由</th>
                <th className="p-2">試行</th>
                <th className="p-2">失敗した時刻</th>
                <th className="p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b align-top">
                  <td className="p-2 font-bold">{job.jobType}</td>
                  <td className="p-2 text-xs">
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
                  <td className="p-2">
                    <p className="text-xs font-bold">{job.errorCode ?? '—'}</p>
                    <p className="text-xs leading-relaxed">
                      {job.errorMessage ?? ''}
                    </p>
                  </td>
                  <td className="p-2">{job.attemptCount}</td>
                  <td className="p-2 text-xs">{formatAt(job.completedAt)}</td>
                  <td className="p-2">
                    <JobRetryButton jobId={job.id} jobType={job.jobType} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
