'use client';

import { useEffect, useState } from 'react';
import { BlogApiError, fetchBlogs, type BlogJson } from '../_lib/blogs-api';
import { WeeklyResultForm } from './_components/weekly-result-form';

/**
 * `/liff/results` 成果の入力（TASKS G-5、SPEC 6.1）。
 *
 * 完了条件は「成果件数と報酬額のみ入力。0件を1操作で記録できる」。
 *
 * **SPEC 6.1 の集計（検索表示・クリック・AI費用など）はここに無い。**
 * 自動で集める側（G-2・G-6）が未実装で、**空の枠だけ並べると
 * 「取れているのに0」と読める**。
 */
export default function ResultsPage() {
  const [blogs, setBlogs] = useState<BlogJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        ASPの管理画面で確認した今週の成果を記録してください。
        成果が無かった週も記録すると、あとから振り返れます。
      </p>

      {blogs.length === 0 ? (
        <p className="mt-6 text-sm">まだブログがありません。</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {blogs.map((blog) => (
            <WeeklyResultForm
              key={blog.id}
              blogId={blog.id}
              blogName={blog.name}
            />
          ))}
        </div>
      )}
    </main>
  );
}
