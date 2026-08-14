'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  OnboardingApiError,
  fetchOnboarding,
  type OnboardingProgressJson,
  type OnboardingStep,
} from '../_lib/onboarding-api';

/**
 * `/liff/onboarding` はじめの設定（TASKS H-2a、SPEC 6.1、Q-035）。
 *
 * ## 中断・再開ができる
 *
 * **現在地はサーバーがデータから導く**（`/api/onboarding`）。この画面は
 * 状態を持たないので、**閉じて開き直しても同じところから続けられる。**
 *
 * ## 済んだ段も開ける
 *
 * 設定を直したくなるのは普通のこと。「先へ進む」だけにすると、
 * **直すために最初からやり直す**ことになる。
 *
 * ## 行き先が無い段は1つだけ
 *
 * `LINE_LOGIN` は**この画面が見えている時点で済んでいる**ので、行き先が
 * 要らない。同意（段2・3）と通知（段9）は H-2b で足した。
 */

interface StepView {
  title: string;
  description: string;
  /**
   * 行き先。**まだ画面が無い段は `null`**（H-2b で足す）。
   *
   * `Route` にしておくと、**存在しないパスを書いた時点で型検査が落ちる**
   * （Next.js の typed routes）
   */
  href: Route | null;
}

const STEP_VIEWS: Record<OnboardingStep, StepView> = {
  LINE_LOGIN: {
    title: 'LINEでログイン',
    description: 'この画面が見えていれば済んでいます',
    href: null,
  },
  TERMS: {
    title: '利用規約に同意する',
    description: '参加の条件を確認します',
    href: '/liff/onboarding/consent',
  },
  DATA_CONSENT: {
    title: 'データの使い方に同意する',
    description: '実験の記録として何を残すかを確認します',
    href: '/liff/onboarding/consent',
  },
  PERSONA: {
    title: '分身をつくる',
    description:
      '記事を書く人格です。収益の目標とやめる条件もここで決めます（1体目から始めます）',
    href: '/liff/personas/new',
  },
  BLOG: {
    title: 'ブログの枠をつくる',
    // **作る画面を指す。** ここが一覧を指していて、一覧が
    // 「オンボーディングから登録してください」と書いていたため、
    // 段5がどこからも通せなかった（実地で判明）
    description: '分身が書く媒体です。分身1体につき1つ',
    href: '/liff/blogs/new',
  },
  WORDPRESS: {
    title: 'WordPress をつなぐ',
    description: '接続テストが通るまでが1つの作業です',
    href: '/liff/blogs',
  },
  GENRE: {
    title: 'ジャンルを決める',
    description: '何について書くブログかを決めます',
    href: '/liff/blogs',
  },
  OFFER: {
    title: '案件を登録する',
    description: '紹介する商品・サービスを登録します',
    href: '/liff/blogs',
  },
  NOTIFICATION: {
    title: '通知の曜日と時刻を決める',
    description: '提案が届く時間帯です',
    href: '/liff/onboarding/notification',
  },
  SNIPPET: {
    title: 'リンク計測を入れる',
    description:
      'ブログに小さなプラグインを入れます。入れないと記事のリンクが開けません',
    href: '/liff/blogs',
  },
};

export default function OnboardingPage() {
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

  if (error !== null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  if (progress === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">はじめの設定</h1>
      <p className="mt-1 text-xs">
        {progress.doneCount} / {progress.totalCount} 件
      </p>

      {progress.completed ? (
        <p className="mt-4 text-sm leading-relaxed">
          設定はすべて終わっています。あとは届く提案に答えていくだけです。
        </p>
      ) : (
        <p className="mt-4 text-sm leading-relaxed">
          途中でやめても大丈夫です。次に開いたときは、ここから続けられます。
        </p>
      )}

      <ol className="mt-4 flex flex-col gap-3">
        {progress.steps.map((state, index) => {
          const view = STEP_VIEWS[state.step];

          return (
            <li
              key={state.step}
              className="rounded-lg border p-4"
              aria-current={state.current ? 'step' : undefined}
            >
              <p className="text-xs">
                {index + 1}／{progress.totalCount}・
                {state.done ? '済み' : state.current ? 'いまここ' : 'まだ'}
              </p>
              <p className="mt-1 text-base font-bold">{view.title}</p>
              <p className="mt-1 text-xs leading-relaxed">{view.description}</p>

              {view.href === null ? (
                state.done ? null : (
                  <p className="mt-2 text-xs">この画面はまだありません</p>
                )
              ) : (
                <Link href={view.href} className="mt-2 block text-xs underline">
                  {state.done ? '見直す' : '開く'}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
