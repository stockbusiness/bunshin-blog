import Link from 'next/link';
import { headers } from 'next/headers';
import type { Route } from 'next';
import { requireAdmin } from '@/modules/auth';
import { Page, PageHeader } from './_components/ui';

/**
 * `/admin` の入口（TASKS B-6）。
 *
 * **B-6 は「MONITORが `/admin` へアクセスできない」ことまで。**
 * SPEC 6.2 の `/admin/dashboard`（集計）は G-7、モニター一覧は B-7 に置く。
 * ここは入口の一覧に徹する。
 *
 * ## 何のための画面かを1行で書く
 *
 * 題だけ並べると、**開くまで何ができるか分からない。**
 * 10枚あるので、開いて戻るのを繰り返すことになる。
 *
 * ## 並び順は使う順
 *
 * 上から**毎日見るもの → ときどき見るもの → 一度きりの設定**。
 * 名前の順に並べない（探すのは名前ではなく用事）。
 */

interface Entry {
  href: Route;
  title: string;
  description: string;
}

const ENTRIES: readonly Entry[] = [
  {
    href: '/admin/users' as Route,
    title: 'モニター',
    description: '登録・同意・オンボーディングの状況。参加の承認と停止',
  },
  {
    href: '/admin/monitor-activity' as Route,
    title: '反応',
    description: '14日で見る。届いているのに押されていない人を先に見つける',
  },
  {
    href: '/admin/genres' as Route,
    title: 'ジャンル審査（段7）',
    description: 'ブログにジャンルを付ける。停止条件を満たすものは付かない',
  },
  {
    href: '/admin/offer-catalog' as Route,
    title: '案件カタログ',
    description: 'モニターが段8で選ぶ案件。ここの事実が全員の記事に載る',
  },
  {
    href: '/admin/fact-issues' as Route,
    title: '事実の指摘',
    description: '見逃した事実誤りの記録。機械が見つけた分だけでは分母が無い',
  },
  {
    href: '/admin/jobs' as Route,
    title: 'ジョブ',
    description: '失敗して止まったものを積み直す',
  },
  {
    href: '/admin/dashboard' as Route,
    title: '集計',
    description: 'ジャンル別・戦略別・ブログ別。測れていない指標は並べない',
  },
  {
    href: '/admin/publish-pace' as Route,
    title: '公開ペース',
    description: '自動で本数を増減した回の記録。変わった回だけが並ぶ',
  },
  {
    href: '/admin/rich-menu' as Route,
    title: 'LINEのメニュー',
    description: 'トーク画面の下に出るメニュー。全モニター共通で1つ',
  },
  {
    href: '/admin/settings' as Route,
    title: '設定',
    description: 'APIキーと接続テスト。秘密は末尾4文字しか出ない',
  },
];

export default async function AdminHomePage() {
  // **レイアウトの判定だけに頼らない**（B-6）。理由の表示はレイアウトの
  // 仕事なので、ここでは何も描かずに戻る。例外をそのまま投げると
  // 拒否のたびにエラー境界へ落ち、未処理例外としてログに残る
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );
  if (admin === null) {
    return null;
  }

  return (
    <Page>
      <PageHeader title="管理画面" meta={`${admin.displayName} さん`} />

      <ul className="grid gap-3 sm:grid-cols-2">
        {ENTRIES.map((entry) => (
          <li key={entry.href}>
            <Link
              href={entry.href}
              className="block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-400 hover:shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              <p className="text-sm font-bold text-slate-900">{entry.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                {entry.description}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
