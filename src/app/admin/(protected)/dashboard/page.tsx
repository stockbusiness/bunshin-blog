import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { aggregateForAdmin, type AggregateAxis } from './_lib/aggregate';

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
    <div>
      <h1 className="text-lg font-bold">実験の集計</h1>

      <p className="mt-2 text-sm leading-relaxed">
        実験グループの割当はSQLで行います（SPEC 10.3）。ここは読むだけです。
      </p>

      {sections.map((section) => (
        <section key={section.axis} className="mt-8">
          <h2 className="text-base font-bold">{section.title}</h2>

          {section.rows.length === 0 ? (
            <p className="mt-2 text-sm">まだブログがありません。</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">{section.title.replace('別', '')}</th>
                    <th className="p-2">ブログ</th>
                    <th className="p-2">公開</th>
                    <th className="p-2">検索表示</th>
                    <th className="p-2">検索クリック</th>
                    <th className="p-2">広告リンク</th>
                    <th className="p-2">AI経由</th>
                    <th className="p-2">成果</th>
                    <th className="p-2">収益</th>
                    <th className="p-2">AI費用</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => (
                    <tr key={row.label}>
                      <td className="p-2">{row.label}</td>
                      <td className="p-2">{row.blogs}</td>
                      <td className="p-2">{row.postedArticles}</td>
                      <td className="p-2">
                        {row.impressions.toLocaleString()}
                      </td>
                      <td className="p-2">
                        {row.searchClicks.toLocaleString()}
                      </td>
                      <td className="p-2">
                        {row.affiliateClicks.toLocaleString()}
                      </td>
                      <td className="p-2">
                        {row.aiReferrals.toLocaleString()}
                      </td>
                      <td className="p-2">
                        {row.conversions.toLocaleString()}
                      </td>
                      <td className="p-2">{yen(row.revenueYen)}</td>
                      <td className="p-2">{usd(row.aiCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      {/* **測っていないものを0で並べない**（Q-032） */}
      <p className="mt-8 text-xs leading-relaxed">
        広告クリックとPVは測る経路がまだありません（Q-032）。0として並べると
        「測ったが0だった」と読めるため、列を出していません。
      </p>
      <p className="mt-2 text-xs leading-relaxed">
        AI経由の流入は「判別可能なAIサービス経由流入数」です。referrerが欠落する
        場合があるため、完全値ではありません（SPEC 11.4）。
      </p>
      <p className="mt-2 text-xs leading-relaxed">
        検索の数値はSearch Consoleの暦日、成果はJSTの週で記録しています。
        突き合わせると最大1日ずれます（Q-005）。
      </p>
    </div>
  );
}
