/**
 * 管理画面の共通部品。
 *
 * ## なぜ部品にするのか
 *
 * 画面が10枚あり、**同じものが少しずつ違う形で書かれていた**
 * （見出しの大きさ、余白、表の罫線）。**同じものは同じに見せる。**
 * 違って見えるものは「違う意味がある」と読まれる。
 *
 * ## `'use client'` を付けない
 *
 * **状態を持たない。** ここは見た目だけで、
 * サーバーの画面からもクライアントの部品からも使える。
 *
 * ## 色に意味を持たせる
 *
 * **赤は「放っておくと失われる」**（失敗・停止・YMYL）。
 * **黄は「進むが、人が見るべき」**（警告・未完了）。
 * それ以外は灰。**意味の無い色を使わない** — 使うと、
 * 本当に赤くしたいものが埋もれる。
 */

import Link from 'next/link';
import type { Route } from 'next';

/** 押せるものの見た目。**クライアントの部品からも使う**ので文字列で持つ */
export const BUTTON =
  'inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50';

/** その画面でいちばんしたいこと。**1画面に1つまで** */
export const BUTTON_PRIMARY =
  'inline-flex items-center justify-center gap-1 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50';

/** 戻せない操作。**押す前に手が止まる色にする** */
export const BUTTON_DANGER =
  'inline-flex items-center justify-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:cursor-not-allowed disabled:opacity-50';

export const INPUT =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-slate-900';

export const LABEL = 'flex flex-col gap-1 text-sm font-medium text-slate-700';

/** 入力の下に置く補足。**なぜそれを入れるのかを書く場所** */
export const HINT = 'text-xs leading-relaxed text-slate-500';

/**
 * 画面の見出し。
 *
 * **`lead` に「この画面で何ができるか」を書く。** 題だけだと、
 * 初めて開いた人がボタンを押すまで分からない。
 */
export function PageHeader({
  title,
  lead,
  meta,
}: {
  title: string;
  lead?: React.ReactNode;
  /** 件数など、題のとなりに出す短い事実 */
  meta?: React.ReactNode;
}) {
  return (
    <header className="border-b border-slate-200 pb-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          {title}
        </h1>
        {meta === undefined ? null : (
          <p className="text-sm text-slate-500">{meta}</p>
        )}
      </div>
      {lead === undefined ? null : (
        <div className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
          {lead}
        </div>
      )}
    </header>
  );
}

/** ひとまとまり。**題を付けられないものは Card にしない** */
export function Card({
  title,
  description,
  children,
  tone = 'plain',
}: {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'plain' | 'warn' | 'danger';
}) {
  const border =
    tone === 'danger'
      ? 'border-red-200 bg-red-50'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50'
        : 'border-slate-200 bg-white';

  return (
    <section className={`rounded-xl border p-4 shadow-sm ${border}`}>
      {title === undefined ? null : (
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
      )}
      {description === undefined ? null : (
        <div className="mt-1 text-sm leading-relaxed text-slate-600">
          {description}
        </div>
      )}
      <div className={title === undefined ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

/**
 * 表を包む。
 *
 * **横に溢れさせない。** 管理画面の表は列が多く、
 * 包まないと**画面ごと横に伸びて**、他の画面まで読みにくくなる。
 */
export function TableFrame({
  children,
  minWidth = '48rem',
}: {
  children: React.ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const TH =
  'whitespace-nowrap bg-slate-50 px-3 py-2 text-left text-xs font-bold text-slate-600';

export const TD =
  'border-t border-slate-100 px-3 py-3 align-top text-slate-700';

/**
 * 何も無いとき。
 *
 * **「無い」と「壊れている」を見分けられるようにする。**
 * 白紙だけ出すと、読み込みに失敗したように見える。
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm leading-relaxed text-slate-500">
      {children}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-slate-200 bg-slate-100 text-slate-700',
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-800',
};

/** 状態の札。**文字も併記する** — 色だけで区別させない */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * 画面のいちばん下に置く「戻る」。
 *
 * **上のナビだけに頼らない。** 表が長い画面では、
 * 読み終えた位置から**上まで戻らないと移動できない。**
 */
export function BackLink({
  href = '/admin' as Route,
  children = '管理画面へ戻る',
}: {
  href?: Route;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-t border-slate-200 pt-4">
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900"
      >
        <span aria-hidden="true">←</span>
        {children}
      </Link>
    </div>
  );
}

/** 画面の中身をまとめて、余白と幅をそろえる */
export function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">{children}</div>
  );
}
