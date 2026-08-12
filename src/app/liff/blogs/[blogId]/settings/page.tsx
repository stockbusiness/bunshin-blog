'use client';

import Link from 'next/link';
import { use, useEffect, useId, useState } from 'react';
import {
  BlogApiError,
  fetchBlog,
  saveBlogSettings,
  type BlogJson,
  type BlogPurpose,
  type BlogSettingsInput,
  type BrokenLinkJson,
} from '../../../_lib/blogs-api';
import {
  PURPOSE_LABELS,
  PURPOSE_VALUES,
  SELECTABLE_STATUSES,
  STATUS_LABELS,
} from '../../../_lib/labels';

/**
 * `/liff/blogs/[blogId]/settings` ブログ設定（TASKS B-5、SPEC 6.1）。
 *
 * 編集できるのは名前・ペンネーム・想定読者・収益方針・投稿頻度・状態。
 *
 * - **ジャンルは表示のみ。** 変更は E-4 の審査を経由する（Q-009）
 * - **収益記事・集客記事の本数は表示のみ。** SPEC 9.2.4 の算出値（Q-011）
 * - **通知設定はここに置かない。** ユーザー単位でオンボーディングが扱う（Q-010）
 * - `slug` と枠番号は出さない。前者は WordPress 側の識別に関わり、
 *   後者はサーバーが決める（B-4）
 */

/** 週の公開上限。SPEC 2.2「週4本を超えて公開する処理を実装してはならない」 */
const PUBLISH_CAP_CHOICES = [1, 2, 3, 4];

type FormState = BlogSettingsInput;

function toFormState(blog: BlogJson): FormState {
  return {
    name: blog.name,
    penName: blog.penName,
    targetReader: blog.targetReader,
    purpose: blog.purpose,
    // CLOSED のブログはこの画面へ来ない前提だが、来ても選べる値に丸める
    status: blog.status === 'CLOSED' ? 'PAUSED' : blog.status,
    weeklyPublishCap: blog.articleRatio.weeklyPublishCap,
  };
}

export default function BlogSettingsPage({
  params,
}: {
  params: Promise<{ blogId: string }>;
}) {
  const { blogId } = use(params);

  const [blog, setBlog] = useState<BlogJson | null>(null);
  const [brokenLinks, setBrokenLinks] = useState<BrokenLinkJson[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchBlog(blogId).then(
      (result) => {
        if (cancelled) return;
        setBlog(result.blog);
        setBrokenLinks(result.brokenLinks);
        setForm(toFormState(result.blog));
      },
      (thrown: unknown) => {
        if (cancelled) return;
        setLoadError(
          thrown instanceof BlogApiError
            ? thrown.message
            : '読み込めませんでした',
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [blogId]);

  if (loadError !== null) {
    return (
      <main className="min-h-dvh p-6">
        <p className="text-sm leading-relaxed">{loadError}</p>
        <Link
          href="/liff/blogs"
          className="mt-4 inline-block text-sm underline"
        >
          ブログ一覧へ
        </Link>
      </main>
    );
  }

  if (blog === null || form === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);

    try {
      // 空のペンネームは未設定として送る。空文字を保存すると
      // 「設定した」と「していない」が区別できなくなる
      const result = await saveBlogSettings(blogId, {
        ...form,
        penName:
          form.penName === null || form.penName === '' ? null : form.penName,
      });
      setBlog(result.blog);
      setForm(toFormState(result.blog));
      setSaved(true);
    } catch (thrown) {
      setSaveError(
        thrown instanceof BlogApiError
          ? thrown.message
          : '保存できませんでした',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-dvh p-4">
      <Link href="/liff/blogs" className="text-xs underline">
        ブログ一覧へ
      </Link>
      <h1 className="mt-3 text-lg font-bold">{blog.name} の設定</h1>

      <BrokenLinkSection links={brokenLinks} />

      <form
        onSubmit={(e) => void submit(e)}
        className="mt-4 flex flex-col gap-5"
      >
        <Field label="ブログ名">
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              maxLength={100}
              required
              className="w-full rounded border p-3 text-base"
            />
          )}
        </Field>

        <Field label="ペンネーム" hint="記事の書き手として表示されます">
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="text"
              value={form.penName ?? ''}
              onChange={(e) => update('penName', e.target.value)}
              maxLength={100}
              className="w-full rounded border p-3 text-base"
            />
          )}
        </Field>

        <Field label="想定読者" hint="誰に向けて書くかを具体的に">
          {(fieldProps) => (
            <textarea
              {...fieldProps}
              value={form.targetReader}
              onChange={(e) => update('targetReader', e.target.value)}
              maxLength={500}
              required
              rows={4}
              className="w-full rounded border p-3 text-base"
            />
          )}
        </Field>

        <Field label="収益方針">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={form.purpose}
              onChange={(e) => update('purpose', e.target.value as BlogPurpose)}
              className="w-full rounded border p-3 text-base"
            >
              {PURPOSE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {PURPOSE_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="投稿頻度" hint="週の公開本数の上限（最大4本）">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={form.weeklyPublishCap}
              onChange={(e) =>
                update('weeklyPublishCap', Number(e.target.value))
              }
              className="w-full rounded border p-3 text-base"
            >
              {PUBLISH_CAP_CHOICES.map((value) => (
                <option key={value} value={value}>
                  週 {value} 本
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="状態">
          {(fieldProps) => (
            <select
              {...fieldProps}
              value={form.status}
              onChange={(e) =>
                update('status', e.target.value as FormState['status'])
              }
              className="w-full rounded border p-3 text-base"
            >
              {SELECTABLE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <button
          type="submit"
          disabled={saving}
          className="rounded bg-black p-4 text-base font-bold text-white disabled:opacity-50"
        >
          {saving ? '保存しています' : '保存する'}
        </button>

        {saveError === null ? null : (
          <p className="text-sm leading-relaxed">{saveError}</p>
        )}
        {saved ? <p className="text-sm">保存しました</p> : null}
      </form>

      <ReadOnlySection blog={blog} />
    </main>
  );
}

/**
 * 入力欄1つぶんの見出しと補足。
 *
 * **補足を `<label>` の中に入れない。** 中に入れると読み上げ時の項目名が
 * 「ペンネーム 記事の書き手として表示されます」になり、項目名として
 * 使えなくなる。`aria-describedby` で別に結びつける。
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-describedby': hint === undefined ? undefined : hintId,
      })}
    </div>
  );
}

/**
 * 変更できない項目。
 *
 * **なぜ変えられないかを書く。** 触れないだけの項目が並んでいると、
 * 設定漏れだと思われて問い合わせになる。
 */
function ReadOnlySection({ blog }: { blog: BlogJson }) {
  return (
    <section className="mt-8 border-t pt-6">
      <h2 className="text-sm font-bold">ここから変更できない項目</h2>

      <dl className="mt-3 flex flex-col gap-4 text-sm">
        <div>
          <dt className="font-bold">ジャンル</dt>
          <dd>{blog.genre === null ? '未設定' : blog.genre.name}</dd>
          <dd className="mt-1 text-xs leading-relaxed">
            ジャンルは審査を通して決まります。変更したい場合はサポートへご連絡ください。
          </dd>
        </div>

        <div>
          <dt className="font-bold">記事の内訳</dt>
          <dd>
            収益記事 {blog.articleRatio.revenue} 本・集客記事{' '}
            {blog.articleRatio.traffic} 本
          </dd>
          <dd className="mt-1 text-xs leading-relaxed">
            案件数などから自動で計算されます。
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * 何日前から切れているかを出す（H-3b）。
 *
 * **日付そのものより「何日前か」。** 「8月3日から」と言われても、
 * 今日が何日かを数え直すことになる。
 */
function daysAgo(from: Date, now: Date): number {
  const diff = now.getTime() - from.getTime();

  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1_000)));
}

/**
 * いま切れているリンク（H-3b、SPEC 6.1「エラー」）。
 *
 * **切れていないときは何も出さない。**「問題ありません」と書くと、
 * 確認できていない案件まで問題なしに見える（確認の結果が無いことと、
 * 確認して問題が無かったことは別）。
 *
 * **直し方を書く。** 「切れています」だけだと何をすればよいか分からない。
 */
function BrokenLinkSection({ links }: { links: BrokenLinkJson[] }) {
  if (links.length === 0) {
    return null;
  }

  const now = new Date();

  return (
    <section className="mt-4 rounded border border-red-300 bg-red-50 p-4">
      <h2 className="text-sm font-bold text-red-900">
        リンクが切れています（{links.length}件）
      </h2>

      <ul className="mt-2 flex flex-col gap-2 text-sm text-red-900">
        {links.map((link) => {
          const days = daysAgo(new Date(link.brokenAt), now);

          return (
            <li key={link.offerId}>
              {link.offerName}
              <span className="ml-1 text-xs">
                （{days === 0 ? '今日から' : `${String(days)}日前から`}）
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs leading-relaxed text-red-900">
        案件が終了しているか、リンク先が移動しています。ASPの管理画面でご確認のうえ、
        サポートへご連絡ください。切れたままの案件は記事から外されません。
      </p>
    </section>
  );
}
