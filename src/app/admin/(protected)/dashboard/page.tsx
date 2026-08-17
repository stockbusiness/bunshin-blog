import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { aggregateForAdmin, type AggregateAxis } from './_lib/aggregate';
import {
  BackLink,
  Card,
  EmptyState,
  Page,
  PageHeader,
  TD,
  TH,
  TableFrame,
} from '../_components/ui';

/** 数の列。**右に寄せて桁をそろえる** */
const NUM = 'text-right tabular-nums whitespace-nowrap';

/**
 * 実験の集計（TASKS G-7、SPEC 10.3）。
 *
 * 完了条件は「**ジャンル別・戦略別・ブログ別の集計がSQLで取得できる**」。
 *
 * ## 作らないもの
 *
 * SPEC 10.3 が「**実験グループの作成・割当・比較を行う管理UIは実装しない**」と
 * 定めている。ここは**読むだけ**で、グループの割当はSQLかシードで行う。
 *
 * ## 測っていない列を並べない
 *
 * 広告クリックとPVは**測る経路が無い**（Q-032）。0として並べると
 * 「測ったが0だった」と読めるため、**列そのものを出さない。**
 * G-5 で「取れていない指標の枠を並べない」と決めたのと同じ。
 */

export const dynamic = 'force-dynamic';

const AXES: readonly { axis: AggregateAxis; title: string }[] = [
  { axis: 'GENRE', title: 'ジャンル別' },
  { axis: 'STRATEGY', title: '戦略別' },
  { axis: 'BLOG', title: 'ブログ別' },
];

function yen(value: number): string {
  return `${value.toLocaleString()}円`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default async function AdminDashboardPage() {
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );

  if (admin === null) {
    return null;
  }

  const sections = await Promise.all(
    AXES.map(async (entry) => ({
      ...entry,
      rows: await aggregateForAdmin(entry.axis),
    })),
  );

  return (
    <Page>
      <PageHeader
        title="実験の集計"
        lead="実験グループの割当はSQLで行います（SPEC 10.3）。ここは読むだけです。"
      />

      {sections.map((section) => (
        <section key={section.axis} className="flex flex-col gap-3">
          <h2 className="text-base font-bold text-slate-900">
            {section.title}
          </h2>

          {section.rows.length === 0 ? (
            <EmptyState>まだブログがありません。</EmptyState>
          ) : (
            <TableFrame minWidth="60rem">
              <thead>
                <tr>
                  <th className={TH}>{section.title.replace('別', '')}</th>
                  <th className={TH}>ブログ</th>
                  <th className={TH}>公開</th>
                  <th className={TH}>検索表示</th>
                  <th className={TH}>検索クリック</th>
                  <th className={TH}>広告リンク</th>
                  <th className={TH}>AI経由</th>
                  <th className={TH}>成果</th>
                  <th className={TH}>収益</th>
                  <th className={TH}>AI費用</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.label}>
                    <td className={`${TD} font-medium text-slate-900`}>
                      {row.label}
                    </td>
                    {/* **数は右に寄せる。** 桁が揃わないと比べられない */}
                    <td className={`${TD} ${NUM}`}>{row.blogs}</td>
                    <td className={`${TD} ${NUM}`}>{row.postedArticles}</td>
                    <td className={`${TD} ${NUM}`}>
                      {row.impressions.toLocaleString()}
                    </td>
                    <td className={`${TD} ${NUM}`}>
                      {row.searchClicks.toLocaleString()}
                    </td>
                    <td className={`${TD} ${NUM}`}>
                      {row.affiliateClicks.toLocaleString()}
                    </td>
                    <td className={`${TD} ${NUM}`}>
                      {row.aiReferrals.toLocaleString()}
                    </td>
                    <td className={`${TD} ${NUM}`}>
                      {row.conversions.toLocaleString()}
                    </td>
                    <td className={`${TD} ${NUM}`}>{yen(row.revenueYen)}</td>
                    <td className={`${TD} ${NUM}`}>{usd(row.aiCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          )}
        </section>
      ))}

      {/* **測っていないものを0で並べない**（Q-032） */}
      <Card title="この表の読み方">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-xs leading-relaxed text-slate-600">
          <li>
            広告クリックとPVは<strong>測る経路がまだありません</strong>
            （Q-032）。0として並べると「測ったが0だった」と読めるため、
            列を出していません。
          </li>
          <li>
            AI経由の流入は「判別可能なAIサービス経由流入数」です。referrerが
            欠落する場合があるため、<strong>完全値ではありません</strong>
            （SPEC 11.4）。
          </li>
          <li>
            検索の数値はSearch Consoleの暦日、成果はJSTの週で記録しています。
            <strong>突き合わせると最大1日ずれます</strong>（Q-005）。
          </li>
        </ul>
      </Card>

      <BackLink />
    </Page>
  );
}
