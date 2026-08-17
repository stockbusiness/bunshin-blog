'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import {
  BlogApiError,
  createBlog,
  fetchBlogs,
  type BlogListJson,
} from '../../_lib/blogs-api';
import {
  PersonaApiError,
  fetchPersonas,
  type PersonaJson,
} from '../../_lib/personas-api';

/**
 * `/liff/blogs/new` ブログの枠をつくる（オンボーディング段5・H-2）。
 *
 * ## なぜ後から足したか
 *
 * **`POST /api/blogs` は B-3 からあったが、呼ぶ画面がどこにも無かった。**
 * 実地で通したところ、段5の「開く」が `/liff/blogs` へ行き、そこには
 * 「オンボーディングから登録してください」と書いてあった。
 * **オンボーディングと一覧が互いを指していて、作る場所が無い。**
 *
 * B-5 の一覧は「SPEC 6.1 の『追加』はオンボーディング STEP 5 が担う」と
 * 書いていた。段5は `/liff/blogs` を指していた。**どちらも相手が持つと
 * 思っていた。**
 *
 * ## 聞くことを4つに絞る
 *
 * ペンネーム・収益方針・状態・枠番号は**聞かない**。既定で作って、
 * 直したい人だけ設定画面（B-5）で触る。枠番号はサーバーが空いている
 * 最小の番号を割り当てる（B-4）。
 *
 * **最初の1つを作るまでに聞くことを増やすと、そこで止まる**（Q-047）。
 * 段4で実際に止まった直後なので、同じ形を繰り返さない。
 */

/** 想定読者の上限（`POST /api/blogs` の `targetReader`） */
const TARGET_READER_MAX = 500;

interface FormState {
  personaId: string;
  name: string;
  slug: string;
  targetReader: string;
}

const EMPTY_FORM: FormState = {
  personaId: '',
  name: '',
  slug: '',
  targetReader: '',
};

/**
 * 分身から想定読者の下書きを作る。
 *
 * **同じことを二度書かせない。** 読者像は分身が既に持っている
 * （`audience`）。空欄から書かせると、**分身と食い違う読者像が入る。**
 */
function draftTargetReader(persona: PersonaJson): string {
  const { ageRange, situation } = persona.audience;

  return `${ageRange}。${situation}`.slice(0, TARGET_READER_MAX);
}

/**
 * 分身からブログの名前の下書きを作る（Q-058）。
 *
 * **打たせない。** この名前は**LINEの通知でブログを見分けるためのもの**で、
 * 読者には見えない（読者が見るのは WordPress 側の題）。
 *
 * **書きたいと答えたことから作る。** 通知に出たときに、
 * どのブログの話かがすぐ分かる。
 *
 * **分身1体につきブログ1つ**なので、名前が重なることはない。
 */
export function draftBlogName(persona: PersonaJson): string {
  const field = persona.expertise.fields[0]?.trim();

  return `${field === undefined || field === '' ? persona.name : field}のブログ`.slice(
    0,
    100,
  );
}

export default function NewBlogPage() {
  const router = useRouter();
  const nameId = useId();
  const slugId = useId();
  const readerId = useId();
  const personaId = useId();

  const [personas, setPersonas] = useState<PersonaJson[] | null>(null);
  const [slots, setSlots] = useState<BlogListJson['slots'] | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([fetchPersonas(), fetchBlogs()]).then(
      ([personaList, blogList]) => {
        if (cancelled) return;

        // **使い始めた分身しか選べない。** `DRAFT` で作ろうとすると
        // サーバーが弾く（`POST /api/blogs`）。選ばせてから断らない
        const usable = personaList.personas.filter(
          (persona) => persona.status === 'ACTIVE',
        );

        setPersonas(usable);
        setSlots(blogList.slots);

        // 1体しか無いなら選ばせない。**選択肢が1つの選択は問いではない**
        const only = usable.length === 1 ? usable[0] : undefined;

        if (only !== undefined) {
          setForm((current) => ({
            ...current,
            personaId: only.id,
            name: draftBlogName(only),
            targetReader: draftTargetReader(only),
          }));
        }

        // 既にある数から次の番号を作る。**あくまで下書き**で、直せる
        setForm((current) => ({
          ...current,
          slug: `blog-${blogList.blogs.length + 1}`,
        }));
      },
      (thrown: unknown) => {
        if (cancelled) return;

        setError(
          thrown instanceof BlogApiError || thrown instanceof PersonaApiError
            ? thrown.message
            : '読み込めませんでした',
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null && personas === null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  if (personas === null || slots === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  /*
    **枠が無いことと、分身が無いことは別の詰まり。** どちらも
    「作れません」で終わらせず、次にすることを書く（D-14 と同じ方針）
  */
  if (personas.length === 0) {
    return (
      <main className="min-h-dvh p-4">
        <h1 className="text-lg font-bold">ブログの枠をつくる</h1>
        <p className="mt-4 text-sm leading-relaxed">
          先に分身を1体、使い始めてください。ブログは分身の媒体なので、
          書く人が決まっていないと作れません。
        </p>
        <Link
          href="/liff/personas"
          className="mt-4 block rounded-lg border p-4 text-center text-sm"
        >
          分身の一覧へ
        </Link>
      </main>
    );
  }

  if (slots.remaining <= 0) {
    return (
      <main className="min-h-dvh p-4">
        <h1 className="text-lg font-bold">ブログの枠をつくる</h1>
        <p className="mt-4 text-sm leading-relaxed">
          枠が空いていません（{slots.limit} 枠すべて使っています）。
          閉じた枠は使い回せないため、増やすことはできません。
        </p>
        <Link
          href="/liff/blogs"
          className="mt-4 block rounded-lg border p-4 text-center text-sm"
        >
          ブログの一覧へ
        </Link>
      </main>
    );
  }

  const selected = personas.find((persona) => persona.id === form.personaId);
  const canSubmit =
    !submitting &&
    form.personaId !== '' &&
    form.name.trim() !== '' &&
    form.slug.trim() !== '' &&
    form.targetReader.trim() !== '';

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">ブログの枠をつくる</h1>
      <p className="mt-1 text-xs leading-relaxed">
        あと {slots.remaining} 枠つくれます。ペンネームや収益の方針は、
        できてから設定画面で決められます。
      </p>

      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;

          setSubmitting(true);
          setError(null);

          void createBlog({
            personaId: form.personaId,
            name: form.name.trim(),
            slug: form.slug.trim(),
            targetReader: form.targetReader.trim(),
          }).then(
            (result) => {
              router.push(`/liff/blogs/${result.blog.id}/settings`);
            },
            (thrown: unknown) => {
              setSubmitting(false);
              setError(
                thrown instanceof BlogApiError
                  ? thrown.message
                  : '保存できませんでした',
              );
            },
          );
        }}
      >
        {/*
          1体しか無いときも出す。**誰が書くのかは、隠さずに見せる**
        */}
        <div className="flex flex-col gap-1">
          <label htmlFor={personaId} className="text-sm font-bold">
            書く分身
          </label>
          <select
            id={personaId}
            className="rounded border p-2 text-base"
            value={form.personaId}
            onChange={(event) => {
              const next = personas.find(
                (persona) => persona.id === event.target.value,
              );

              setForm({
                ...form,
                personaId: event.target.value,
                // **名前と読者像は選び直すたびに引き直す。** 前の分身の
                // ものが残ると、書く人と読む人が食い違う
                name: next === undefined ? form.name : draftBlogName(next),
                targetReader:
                  next === undefined
                    ? form.targetReader
                    : draftTargetReader(next),
              });
            }}
          >
            <option value="">選んでください</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
          {selected === undefined ? null : (
            <p className="text-xs leading-relaxed">
              専門：{selected.expertise.fields.join('・')}
            </p>
          )}
        </div>

        {/*
          **打つところを出さない**（Q-058）。名前・記号・読者は
          分身から引いてあり、**直したい人だけ開く**
        */}
        <details>
          <summary className="cursor-pointer text-sm font-bold">
            名前と読者を直す（このままで構いません）
          </summary>

          <div className="mt-3 flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={nameId} className="text-sm font-bold">
                ブログの名前
              </label>
              <input
                id={nameId}
                className="rounded border p-2 text-base"
                value={form.name}
                maxLength={100}
                onChange={(event) => {
                  setForm({ ...form, name: event.target.value });
                }}
              />
              <p className="text-xs leading-relaxed">
                分身から下書きを入れてあります。
                <strong>LINEの通知でブログを見分けるための名前</strong>で、
                読者には見えません。あとから変えられます
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={slugId} className="text-sm font-bold">
                管理用の記号
              </label>
              <input
                id={slugId}
                className="rounded border p-2 text-base"
                value={form.slug}
                maxLength={100}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => {
                  setForm({ ...form, slug: event.target.value });
                }}
              />
              <p className="text-xs leading-relaxed">
                英小文字・数字・ハイフンのみ。3つのブログを見分けるための記号で、
                読者の目には触れません。このままで構いません
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={readerId} className="text-sm font-bold">
                誰に向けて書くか
              </label>
              <textarea
                id={readerId}
                className="rounded border p-2 text-base"
                rows={3}
                value={form.targetReader}
                maxLength={TARGET_READER_MAX}
                onChange={(event) => {
                  setForm({ ...form, targetReader: event.target.value });
                }}
              />
              <p className="text-xs leading-relaxed">
                分身の読者像から下書きを入れてあります。違っていれば直してください
              </p>
            </div>
          </div>
        </details>

        {error === null ? null : (
          <p role="alert" className="text-sm leading-relaxed">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
        >
          {submitting ? '保存しています' : 'つくる'}
        </button>
      </form>

      <Link
        href="/liff/onboarding"
        className="mt-4 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
