'use client';

import Link from 'next/link';
import { useState } from 'react';
import { OnboardingApiError, acceptConsent } from '../../_lib/onboarding-api';

/**
 * `/liff/onboarding/consent` 同意（TASKS H-2b、SPEC 6.1 の段2・3）。
 *
 * **2つを1画面に置く。** 規約とデータ利用は別の同意だが、続けて出さないと
 * 「1つ同意したのに次が来る」という止まり方をする。**記録は別々**
 * （`terms_accepted_at` と `data_use_consent_at`）。
 *
 * **押した時刻は一度だけ記録され、二度目は動かない**（H-4 の記録と揃える）。
 *
 * **取り消しは置かない。** データを残したまま同意だけ外れた状態を作らない。
 * やめるときは退会（H-4）。
 */

interface Section {
  kind: 'TERMS' | 'DATA_USE';
  title: string;
  body: string[];
}

const SECTIONS: Section[] = [
  {
    kind: 'TERMS',
    title: '利用規約',
    body: [
      'この実験に参加するための約束です。',
      'ドメインとサーバーの費用はご自身の負担になります。',
      'ブログはご自身のドメインで動き、記事の公開はご自身の承認で行われます。',
      '承認していない記事が公開されることはありません。',
    ],
  },
  {
    kind: 'DATA_USE',
    title: 'データの使い方',
    body: [
      '実験の結果をまとめるために、次の記録を使わせていただきます。',
      '・提案に答えた記録（承認・修正依頼・見送り）',
      '・公開した記事と、その表示回数やクリック数',
      '・登録した案件と成果の報告',
      'LINEのユーザーIDは、まとめや持ち出しには含めません。',
    ],
  },
];

export default function ConsentPage() {
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">同意のお願い</h1>
      <p className="mt-1 text-xs leading-relaxed">
        2つあります。どちらも読んでから押してください。
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {error}
        </p>
      )}

      {SECTIONS.map((section) => (
        <section key={section.kind} className="mt-4 rounded-lg border p-4">
          <h2 className="text-sm font-bold">{section.title}</h2>
          {section.body.map((line) => (
            <p key={line} className="mt-2 text-xs leading-relaxed">
              {line}
            </p>
          ))}

          {accepted[section.kind] === true ? (
            <p className="mt-3 text-xs">同意しました</p>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              className="mt-3 w-full rounded-lg border p-3 text-sm font-bold disabled:opacity-50"
              onClick={() => {
                setBusy(section.kind);
                setError(null);

                void acceptConsent(section.kind).then(
                  () => {
                    setBusy(null);
                    setAccepted((current) => ({
                      ...current,
                      [section.kind]: true,
                    }));
                  },
                  (thrown: unknown) => {
                    setBusy(null);
                    setError(
                      thrown instanceof OnboardingApiError
                        ? thrown.message
                        : '記録できませんでした',
                    );
                  },
                );
              }}
            >
              {busy === section.kind ? '記録しています' : '同意する'}
            </button>
          )}
        </section>
      ))}

      <Link
        href="/liff/onboarding"
        className="mt-4 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
