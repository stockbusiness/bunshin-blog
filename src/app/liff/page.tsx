'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLiffSession } from './_components/liff-provider';
import {
  OnboardingApiError,
  fetchOnboarding,
  type OnboardingProgressJson,
} from './_lib/onboarding-api';

/**
 * `/liff` モニターの入口。
 *
 * **LIFF のエンドポイントURLはこの画面を指している**（`docs/DEPLOY.md` 3.2）。
 * モニターが LINE から開いて最初に見るのはここで、**ここに無い行き先は
 * 存在しないのと同じ。**
 *
 * ## なぜ作り直したか
 *
 * 元は B-8 の接続確認画面で、**リンクが1つも無かった。** 実地で通した
 * ところ、ログインは成功するのに**はじめの設定へ行けず、そこで詰まった。**
 * あわせて、同意の未済を `terms・dataUse` という**内部の識別子のまま**
 * 出していた。
 *
 * ## 未済のときは「はじめの設定」だけを前に出す
 *
 * 設定が終わるまで、提案も成果も**中身が無い**。同列に並べると、
 * **空の画面を開いて「壊れている」と受け取られる。**
 *
 * ## 済んだ段も開ける
 *
 * `/liff/onboarding` と同じ方針（H-2a）。直すために最初からやり直す、
 * ということにならないように。
 */

interface Destination {
  href: Route;
  title: string;
  description: string;
}

/** 設定が終わってから意味を持つもの。順は使う頻度 */
const DESTINATIONS: readonly Destination[] = [
  {
    href: '/liff/approvals',
    title: '届いている提案',
    description: '記事を読んで、公開するかを決めます',
  },
  {
    href: '/liff/blogs',
    title: 'ブログ',
    description: 'ジャンル・案件・公開の設定',
  },
  {
    href: '/liff/personas',
    title: '分身',
    description: '記事を書く人格の設定',
  },
  {
    href: '/liff/results',
    title: '成果',
    description: '週に一度、件数と報酬を記録します',
  },
];

export default function LiffPage() {
  const session = useLiffSession();
  const [progress, setProgress] = useState<OnboardingProgressJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchOnboarding().then(
      (result) => {
        if (!cancelled) setProgress(result);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
            thrown instanceof OnboardingApiError
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

  if (session.status !== 'ready') {
    // レイアウトが ready 以外を描き分けるため、ここへは来ない
    return null;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">BUNSHIN BLOG</h1>
      <p className="mt-1 text-xs">{session.user.displayName} さん</p>

      {/*
        **読み込めなくても入口は出す。** 通信が一度失敗しただけで
        どこへも行けなくなるのを避ける
      */}
      {error === null ? null : (
        <p className="mt-4 text-xs leading-relaxed">{error}</p>
      )}

      <section className="mt-4">
        <Link
          href="/liff/onboarding"
          className="block rounded-lg border p-4"
          aria-current={
            progress !== null && !progress.completed ? 'page' : undefined
          }
        >
          <p className="text-base font-bold">はじめの設定</p>
          <p className="mt-1 text-xs leading-relaxed">
            {progress === null
              ? '10段あります'
              : progress.completed
                ? 'すべて終わっています。設定を見直せます'
                : `あと ${progress.totalCount - progress.doneCount} 件`}
          </p>
        </Link>
      </section>

      {/*
        **設定が終わるまで並べない。** 中身が無い画面を開かせると
        「壊れている」に見える。読み込めなかったときは出す
        （出さないと、通信の失敗が「機能が無い」に見える）
      */}
      {progress !== null && !progress.completed ? (
        <p className="mt-4 text-xs leading-relaxed">
          はじめの設定が終わると、提案が届くようになります。
        </p>
      ) : (
        <nav className="mt-3 flex flex-col gap-3">
          {DESTINATIONS.map((destination) => (
            <Link
              key={destination.href}
              href={destination.href}
              className="block rounded-lg border p-4"
            >
              <p className="text-base font-bold">{destination.title}</p>
              <p className="mt-1 text-xs leading-relaxed">
                {destination.description}
              </p>
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}
