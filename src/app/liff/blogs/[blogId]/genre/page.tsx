'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import {
  BlogApiError,
  fetchBlog,
  type BlogJson,
} from '../../../_lib/blogs-api';
import { fetchGenres, type GenreJson } from '../../../_lib/genres-api';
import { fetchOffers, type OfferJson } from '../../../_lib/offers-api';

/**
 * `/liff/blogs/[blogId]/genre` ジャンルを決める（段7・Q-049、SPEC 9.2.2）。
 *
 * ## モニターは選ばない
 *
 * **ジャンルは ADMIN が審査を回して付ける**（Q-049 の (b)）。
 * `ymyl_risk` は `genres` マスタの値で、`HIGH` なら無条件で停止する。
 * **自己申告にすると、停止条件を申告で回避できる。**
 *
 * さらに、判定には**検索上位10件の内訳**が要る。取得する仕組みが
 * どこにも無いので、SPEC 9.2.2 のフォールバック（ADMIN の手動入力）を使う。
 *
 * ## それでもこの画面が要る
 *
 * **何が候補にあるのかを見られないと、希望の出しようが無い。**
 * また、**案件が0件だと審査は必ず止まる**（`noOffers`）ので、
 * **先に段8を済ませる必要がある** — それをここで伝える。
 *
 * ## 段の順は入れ替えない
 *
 * SPEC 6.1 は「7. ジャンル設定／8. ASP・案件登録」と定めている。
 * **入れ替えなくても詰まらない** — はじめの設定はどの段へも進めるので、
 * **段7を待たせたまま段8へ行ける。** ここでその順路を示す。
 */

export default function GenrePage({
  params,
}: {
  params: Promise<{ blogId: string }>;
}) {
  const { blogId } = use(params);

  const [blog, setBlog] = useState<BlogJson | null>(null);
  const [genres, setGenres] = useState<GenreJson[]>([]);
  const [offers, setOffers] = useState<OfferJson[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([fetchBlog(blogId), fetchGenres(), fetchOffers(blogId)])
      .then(([detail, genreList, offerList]) => {
        if (cancelled) return;

        setBlog(detail.blog);
        setGenres(genreList.genres);
        setOffers(offerList.offers);
      })
      .catch((thrown: unknown) => {
        if (cancelled) return;

        setError(
          thrown instanceof BlogApiError
            ? thrown.message
            : '読み込めませんでした',
        );
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [blogId]);

  if (!loaded) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  if (error !== null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  // **終了した案件は数えない**（審査も `ENDED` を除いて数える）
  const usableOffers = offers.filter((offer) => offer.status !== 'ENDED');
  const selectable = genres.filter((genre) => genre.ymylRisk !== 'HIGH');
  const blocked = genres.filter((genre) => genre.ymylRisk === 'HIGH');

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">ジャンルを決める</h1>

      {blog?.genre != null ? (
        <section className="mt-4 rounded-lg border p-4">
          <p className="text-sm font-bold">決まっています</p>
          <p className="mt-1 text-sm">
            {blog.genre.category}／{blog.genre.name}
          </p>
          <p className="mt-2 text-xs leading-relaxed">
            この段は済んでいます。変えたいときは運営へお知らせください。
          </p>
        </section>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed">
            <strong>ジャンルは運営が確認して決めます。</strong>
            医療・投資など、書き方に注意が要る分野があるためです。
            希望はLINEでお知らせください。
          </p>

          {/*
            **案件0件は停止条件**（`noOffers`）。ここを伝えないと、
            「希望を出したのに決まらない」がしばらく続く
          */}
          {usableOffers.length === 0 ? (
            <section className="mt-4 rounded-lg border p-4">
              <p className="text-sm font-bold">先に案件を登録してください</p>
              <p className="mt-1 text-xs leading-relaxed">
                <strong>案件が1件も無いと、審査は必ず止まります。</strong>
                段8を先に済ませてください（順番どおりでなくて構いません）。
              </p>
              <Link
                href={`/liff/blogs/${blogId}/offers`}
                className="mt-3 block text-center text-xs underline"
              >
                案件を登録する
              </Link>
            </section>
          ) : (
            <p className="mt-4 text-xs leading-relaxed">
              案件が {usableOffers.length}{' '}
              件あります。運営の確認を待ってください。
            </p>
          )}
        </>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-bold">選べるジャンル</h2>
        {selectable.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed">
            まだ候補がありません。書きたい分野をLINEでお知らせください。
            運営が候補に足します。
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {selectable.map((genre) => (
              <li key={genre.id}>
                {genre.category}／{genre.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        **隠さない。** 「なぜ選べないのか」が見えているほうが、
        別のジャンルへ移りやすい
      */}
      {blocked.length === 0 ? null : (
        <section className="mt-6">
          <h2 className="text-sm font-bold">選べない分野</h2>
          <p className="mt-1 text-xs leading-relaxed">
            お金や健康に関わる分野です。誤った記事の影響が大きいため、
            この実験では扱いません。
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {blocked.map((genre) => (
              <li key={genre.id}>{genre.name}</li>
            ))}
          </ul>
        </section>
      )}

      <Link
        href="/liff/onboarding"
        className="mt-6 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
