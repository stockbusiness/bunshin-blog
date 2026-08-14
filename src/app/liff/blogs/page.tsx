'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BlogApiError, fetchBlogs, type BlogListJson } from '../_lib/blogs-api';
import { STATUS_LABELS } from '../_lib/labels';

/**
 * `/liff/blogs` ブログ一覧（TASKS B-5、SPEC 6.1）。
 *
 * 設定画面への入口。**残枠はサーバーが返す値を出す**（B-4）。
 * `CLOSED` は一覧に出ないため、`blogs.length` から空きを計算できない
 * （OPEN_QUESTIONS Q-008）。
 *
 * ## 「追加」はここが持つ
 *
 * 元は「SPEC 6.1 の『追加』はオンボーディング STEP 5（H-2）が担う」と
 * 書いてあり、**段5はこの画面を指していた。** 互いに相手が持つと思って
 * いて、**作る画面はどこにも無かった**（実地で段5が通れず判明）。
 * いまは `/liff/blogs/new` が持ち、ここと段5の両方から行ける。
 */
export default function BlogListPage() {
  const [data, setData] = useState<BlogListJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchBlogs().then(
      (result) => {
        if (!cancelled) setData(result);
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

  if (data === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">ブログ</h1>
      <p className="mt-1 text-xs">
        {data.blogs.length} / {data.slots.limit} 枠（あと {data.slots.remaining}{' '}
        枠）
      </p>

      {data.blogs.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed">
          まだブログがありません。下から1つめをつくれます。
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {data.blogs.map((blog) => (
            <li key={blog.id} className="rounded-lg border p-4">
              <Link
                href={`/liff/blogs/${blog.id}/settings`}
                className="block"
                aria-label={`${blog.name} の設定`}
              >
                <p className="text-base font-bold">{blog.name}</p>
                <p className="mt-1 text-xs">
                  枠 {blog.slotNumber}・{STATUS_LABELS[blog.status]}・
                  {blog.genre === null ? 'ジャンル未設定' : blog.genre.name}
                </p>
                <p className="mt-2 text-xs underline">設定を開く</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/*
        **空きがあるときだけ出す。** 押しても断られる入口を置くと、
        枠の上限が「壊れている」に見える（B-4）
      */}
      {data.slots.remaining > 0 ? (
        <Link
          href="/liff/blogs/new"
          className="mt-4 block rounded-lg border p-4 text-center text-sm font-bold"
        >
          ブログをつくる
        </Link>
      ) : null}
    </main>
  );
}
