import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import {
  listFactIssuesForAdmin,
  summarizeFactIssuesForAdmin,
} from '@/modules/content-generation';

/**
 * `/admin/fact-issues` 事実誤認の記録（TASKS J-7、Q-044、SPEC 16.2）。
 *
 * **「重大な事実誤認：承認・公開前に100%検知」を確かめるための画面。**
 *
 * これまで記録されていたのは**機械が見つけたものだけ**で、
 * **見逃したものはどこにも残らなかった。** 分母が無いので、
 * 100%かどうかを言えなかった。
 *
 * ## 1件も無いときに 100% と出さない
 *
 * **まだ何も起きていないことが「完璧だった」に見える。**
 */

export const dynamic = 'force-dynamic';

function formatRate(rate: number | null): string {
  return rate === null ? 'まだ判定できない' : `${Math.round(rate * 100)}%`;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export default async function FactIssuesPage() {
  await requireAdmin((await headers()).get('cookie'));

  const [summary, issues] = await Promise.all([
    summarizeFactIssuesForAdmin(),
    listFactIssuesForAdmin({ limit: 50 }),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-xl font-bold">事実誤認の記録</h1>

      <p className="mt-2 text-sm text-gray-600">
        SPEC 16.2 の「重大な事実誤認：承認・公開前に100%検知」を確かめるための
        記録。<strong>公開後に見つかったものも必ず入れる</strong>
        （入れないと、見逃しが無かったのか数えていなかったのか分からない）。
      </p>

      <section className="mt-6 rounded border p-4">
        <h2 className="font-bold">公開前に捕まえた割合（重大なもの）</h2>

        <p className="mt-2 text-3xl">{formatRate(summary.rate)}</p>

        <p className="mt-2 text-sm text-gray-600">
          重大 {summary.major} 件のうち {summary.caughtBeforePublish} 件。
          <br />
          軽微なものは {summary.minor} 件で、
          <strong>割合には入れない</strong>（誤字の多さで数字が動くため）。
        </p>
      </section>

      <h2 className="mt-8 font-bold">最近の記録</h2>

      {issues.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">
          まだ1件も記録がありません。
          <strong>記録が無いことは「誤りが無かった」ではありません。</strong>
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4">見つけた日</th>
                <th className="py-2 pr-4">重さ</th>
                <th className="py-2 pr-4">公開前か</th>
                <th className="py-2">内容</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id} className="border-b">
                  <td className="py-2 pr-4">{formatDate(issue.foundAt)}</td>
                  <td className="py-2 pr-4">
                    {issue.severity === 'MAJOR' ? '重大' : '軽微'}
                  </td>
                  <td className="py-2 pr-4">
                    {issue.caughtBeforePublish ? '公開前' : '公開後'}
                  </td>
                  <td className="py-2">{issue.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-sm text-gray-600">
        記録の追加は <code>POST /api/admin/fact-issues</code>。
      </p>
    </main>
  );
}
