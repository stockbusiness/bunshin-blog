'use client';

import { useEffect, useState } from 'react';
import { BlogApiError, fetchBlogs, type BlogJson } from '../_lib/blogs-api';
import { ResultCsvImport } from './_components/result-csv-import';
import { WeeklyResultForm } from './_components/weekly-result-form';

/**
 * `/liff/results` 成果の入力（TASKS G-5、SPEC 6.1、Q-059・Q-058）。
 *
 * 完了条件は「成果件数と報酬額のみ入力。0件を1操作で記録できる」。
 *
 * ## CSVを先に置く
 *
 * **ASPの契約はユーザー単位**なので、成果は本人しか出せない（Q-057）。
 * だが**数字を打つ必要はない** — ASPが書き出すCSVをそのまま読む（Q-059）。
 * **手で入れる道は残す**（CSVを出せないASPや、直したいときのため）。
 *
 * **SPEC 6.1 の集計（検索表示・クリック・AI費用など）はここに無い。**
 * 自動で集める側（G-2・G-6）が未実装で、**空の枠だけ並べると
 * 「取れているのに0」と読める**。
 */
export default function ResultsPage() {
  const [blogs, setBlogs] = useState<BlogJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // **CSVで記録したら、下の一覧も読み直す。** 増やすと作り直される
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void fetchBlogs().then(
      (result) => {
        if (!cancelled) setBlogs(result.blogs);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
            thrown instanceof BlogApiError
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

  if (blogs === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">成果の記録</h1>
      <p className="mt-1 text-xs leading-relaxed">
        ASPの成果レポートを<strong>CSVで書き出して選ぶだけ</strong>です。
        成果が無かった週も記録すると、あとから振り返れます。
      </p>

      {blogs.length === 0 ? (
        <p className="mt-6 text-sm">まだブログがありません。</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <ResultCsvImport
            onSaved={() => {
              setReloadKey((key) => key + 1);
            }}
          />

          {/* **手で入れる道を塞がない**（CSVを出せないASPもある） */}
          <details>
            <summary className="text-sm">数字を手で入れる</summary>
            <div className="mt-3 flex flex-col gap-4">
              {blogs.map((blog) => (
                <WeeklyResultForm
                  key={`${blog.id}-${String(reloadKey)}`}
                  blogId={blog.id}
                  blogName={blog.name}
                />
              ))}
            </div>
          </details>
        </div>
      )}
    </main>
  );
}
