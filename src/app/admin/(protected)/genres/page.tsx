import { headers } from 'next/headers';
import { requireAdmin } from '@/modules/auth';
import { listBlogsForAdmin, listSelectableGenres } from '@/modules/blogs';
import { GenreCreateForm } from './_components/genre-create-form';
import { GenreReviewForm } from './_components/genre-review-form';

/**
 * `/admin/genres` ジャンルの審査（Q-049、E-4、SPEC 9.2.2）。
 *
 * ## なぜ ADMIN の画面なのか
 *
 * 判定には**検索上位10件の内訳**が要る。**取得する仕組みがどこにも
 * 無い**ので、SPEC 9.2.2 のフォールバック「取得できない場合はADMINの
 * 手動入力値を使う」を正面から使う（Q-049 の (b)）。
 *
 * **ジャンルを直接選ばせる案は採らなかった。** 早いが、
 * **YMYL のジャンルが素通りする。** 30ブログの実験で最初に事故が
 * 起きるのはそこだと考えられる。
 *
 * ## 種に入っているのは YMYL だけ
 *
 * 通すためのジャンルは**この画面から足す。** 実際に何を書けるかは
 * **案件と対になって決まる**（案件0件は停止条件）ので、
 * 先に候補だけ並べても選べない。
 */

export const dynamic = 'force-dynamic';

export default async function AdminGenresPage() {
  const admin = await requireAdmin((await headers()).get('cookie')).catch(
    () => null,
  );

  if (admin === null) {
    return null;
  }

  const [blogs, genres] = await Promise.all([
    listBlogsForAdmin(),
    listSelectableGenres(),
  ]);

  const options = genres.map((genre) => ({
    id: genre.id,
    name: genre.name,
    category: genre.category,
    ymylRisk: genre.ymylRisk,
  }));

  return (
    <main className="mx-auto max-w-3xl">
      <h1 className="text-lg font-bold">ジャンルの審査</h1>
      <p className="mt-2 text-sm leading-relaxed">
        モニターのブログにジャンルを付けます。
        <strong>停止条件を満たすジャンルは付きません</strong>
        （SPEC 9.2.2）。
      </p>

      <GenreCreateForm />

      <section className="mt-6">
        <h2 className="text-base font-bold">ジャンル（{genres.length} 件）</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {genres.map((genre) => (
            <li key={genre.id}>
              {genre.category}／{genre.name}
              {genre.ymylRisk === 'HIGH' ? '・YMYL' : ''}
            </li>
          ))}
        </ul>
      </section>

      {/*
        **ブログが無いうちは審査の入力を出さない。** 出しても
        選ぶ先が無く、「壊れている」に見える
      */}
      {blogs.length === 0 ? (
        <p className="mt-6 text-sm">
          審査できるブログがまだありません。モニターが段5を終えると出ます。
        </p>
      ) : (
        <section className="mt-6">
          <h2 className="text-base font-bold">ブログ（{blogs.length} 件）</h2>

          {blogs.map((blog) => (
            <article key={blog.id} className="mt-4">
              <h3 className="text-sm font-bold">{blog.name}</h3>
              <p className="mt-1 text-xs text-gray-600">
                枠 {blog.slotNumber}・
                {blog.genre === null
                  ? 'ジャンル未設定'
                  : `${blog.genre.category}／${blog.genre.name}`}
              </p>

              <GenreReviewForm blogId={blog.id} genres={options} />
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
