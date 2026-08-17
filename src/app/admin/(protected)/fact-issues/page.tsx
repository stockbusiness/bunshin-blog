import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import {
  FACT_REVIEW_MIN_COUNT,
  FACT_REVIEW_TARGET_COUNT,
  listFactIssuesForAdmin,
  listFactReviewWeeksForAdmin,
  summarizeFactIssuesForAdmin,
  summarizeFactReviewForAdmin,
  type FactIssueFixStatus,
  type FactIssueSource,
} from '@/modules/content-generation';
import {
  Badge,
  BackLink,
  Card,
  EmptyState,
  HINT,
  Page,
  PageHeader,
  TD,
  TH,
  TableFrame,
} from '../_components/ui';

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

/** **どこから見つかったかで打つ手が違う**（2026-08-17 の決定） */
const SOURCE_LABELS: Readonly<Record<FactIssueSource, string>> = {
  MONITOR_REPORT: 'モニターの報告',
  SAMPLING: '抜き取り確認',
  OPERATOR: '運営が発見',
  READER: '読者の指摘',
  OTHER: 'そのほか',
};

const FIX_LABELS: Readonly<Record<FactIssueFixStatus, string>> = {
  NOT_STARTED: '未着手',
  IN_PROGRESS: '直している',
  FIXED: '直した',
  WONT_FIX: '直さない',
};

const FIX_TONES: Readonly<
  Record<FactIssueFixStatus, 'ok' | 'warn' | 'danger' | 'neutral'>
> = {
  NOT_STARTED: 'danger',
  IN_PROGRESS: 'warn',
  FIXED: 'ok',
  WONT_FIX: 'neutral',
};

function formatRate(rate: number | null): string {
  return rate === null ? 'まだ判定できない' : `${Math.round(rate * 100)}%`;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export default async function FactIssuesPage() {
  await requireAdmin((await headers()).get('cookie'));

  const [summary, issues, review, reviewWeeks] = await Promise.all([
    summarizeFactIssuesForAdmin(),
    listFactIssuesForAdmin({ limit: 50 }),
    summarizeFactReviewForAdmin(),
    listFactReviewWeeksForAdmin({ limit: 8 }),
  ]);

  return (
    <Page>
      <PageHeader
        title="事実誤認の記録"
        lead={
          <>
            SPEC 16.2 の「重大な事実誤認：承認・公開前に100%検知」を
            確かめるための記録です。
            <strong>公開後に見つかったものも必ず入れてください</strong>—
            入れないと、見逃しが無かったのか数えていなかったのかが
            分からなくなります。
          </>
        }
      />

      <Card title="公開前に捕まえた割合（重大なもの）">
        <p className="text-4xl font-bold tracking-tight text-slate-900">
          {formatRate(summary.rate)}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          重大 {summary.major} 件のうち {summary.caughtBeforePublish} 件。
          <br />
          軽微なものは {summary.minor} 件で、
          <strong>割合には入れません</strong>（誤字の多さで数字が動くため）。
        </p>
      </Card>

      {/*
        **記録しただけで直っていないのがいちばん悪い**（2026-08-17 の決定）。
        率とは別に、いま手を動かす対象として出す
      */}
      {summary.unfixed === 0 ? null : (
        <Card title="まだ直していない誤り" tone="warn">
          <p className="text-2xl font-bold text-slate-900">
            {summary.unfixed} 件
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            <strong>
              記録しただけで直っていないのがいちばん悪い状態です。
            </strong>
            下の表で「未着手」「直している」のものを確かめてください。
          </p>
        </Card>
      )}

      {/*
        **`fact_issues` が空のとき、「誤りが無かった」のか
        「確かめていない」のかが分からない。** 確認した事実を残す
      */}
      <Card
        title="公開済み記事の抜き取り確認"
        tone={review.reviewedThisWeek ? 'plain' : 'warn'}
      >
        <p className="text-sm leading-relaxed text-slate-600">
          毎週 <strong>{FACT_REVIEW_TARGET_COUNT} 件</strong>
          （負荷が高くても最低 {FACT_REVIEW_MIN_COUNT} 件）を確かめ、
          <strong>確かめたこと自体を記録します</strong>（2026-08-17 の決定）。
          記録しないと、<strong>上の表が空のときに読めなくなります</strong> —
          誤りが無かったのか、確かめていないのかが分かりません。
        </p>

        <p className="mt-3 text-sm">
          {review.reviewedThisWeek ? (
            <>今週は確認済みです。</>
          ) : (
            <strong>今週はまだ確認していません。</strong>
          )}{' '}
          これまで {review.weeks} 週・{review.reviewedTotal} 件を確かめました。
        </p>

        {reviewWeeks.length === 0 ? null : (
          <ul className="mt-3 flex flex-col gap-1 text-xs text-slate-600">
            {reviewWeeks.map((week) => (
              <li key={week.weekStart}>
                {week.weekStart} の週：{week.reviewedCount} 件を確認、
                {week.issueCount} 件の誤り
                {week.note === null ? '' : `（${week.note}）`}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-slate-900">最近の記録</h2>

        {issues.length === 0 ? (
          <EmptyState>
            まだ1件も記録がありません。
            <br />
            <strong>記録が無いことは「誤りが無かった」ではありません。</strong>
          </EmptyState>
        ) : (
          <TableFrame minWidth="40rem">
            <thead>
              <tr>
                <th className={TH}>見つけた日</th>
                <th className={TH}>重さ</th>
                <th className={TH}>公開前か</th>
                <th className={TH}>どこから</th>
                <th className={TH}>直したか</th>
                <th className={TH}>内容</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <tr key={issue.id}>
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {formatDate(issue.foundAt)}
                  </td>
                  <td className={TD}>
                    <Badge
                      tone={issue.severity === 'MAJOR' ? 'danger' : 'neutral'}
                    >
                      {issue.severity === 'MAJOR' ? '重大' : '軽微'}
                    </Badge>
                  </td>
                  <td className={TD}>
                    <Badge tone={issue.caughtBeforePublish ? 'ok' : 'danger'}>
                      {issue.caughtBeforePublish ? '公開前' : '公開後'}
                    </Badge>
                  </td>
                  {/* **打つ手が違う**ので、経路を出す */}
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {SOURCE_LABELS[issue.foundVia]}
                  </td>
                  <td className={TD}>
                    <Badge tone={FIX_TONES[issue.fixStatus]}>
                      {FIX_LABELS[issue.fixStatus]}
                    </Badge>
                  </td>
                  <td className={TD}>{issue.description}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </section>

      <p className={HINT}>
        記録の追加は <code>POST /api/admin/fact-issues</code>、 直したかの記録は{' '}
        <code>PATCH</code>、 抜き取り確認は{' '}
        <code>POST /api/admin/fact-reviews</code>。
      </p>

      <BackLink />
    </Page>
  );
}
