'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { SnippetApiError, issueLinkSnippet } from '../../../_lib/snippet-api';

/**
 * `/liff/blogs/[blogId]/snippet` リンク計測を入れる（段10・I-9/D-12）。
 *
 * ## なぜ後から足したか
 *
 * `MANUAL.md` 段10 は「**『リンク計測のファイルを受け取る』を押すと
 * `bunshin-go.php` が保存されます**」と書いていた。**その押すものが
 * どこにも無かった**（Q-048）。入口（`POST .../link-snippet`）だけが
 * あった。
 *
 * ## 押すと作り直しになる
 *
 * **取得ではなく発行である。** 押すたびに新しいトークンが発行され、
 * **いま置いてあるファイルはその瞬間に効かなくなる。**
 * だから**押す前に書く。** 押してから知らせても遅い。
 *
 * ## 中身を画面に出す
 *
 * ファイルとしても受け取れるが、**LINEの中のブラウザは保存が効かない
 * ことがある。** 出しておけば、少なくとも写せる。
 *
 * **トークンの原文が入っている**（SPEC 14.2）ので、**保存しない。**
 * 画面を離れれば消える。
 */

/** 置き場所。`mu-plugins` なので有効化の操作が要らない */
const DESTINATION = 'wp-content/mu-plugins/';

export default function SnippetPage({
  params,
}: {
  params: Promise<{ blogId: string }>;
}) {
  const { blogId } = use(params);

  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">リンク計測を入れる</h1>
      <p className="mt-1 text-xs leading-relaxed">
        ブログに小さなファイルを1つ置きます。
        <strong>入れないと、記事の中のリンクが開けません</strong>（404
        になります）。
      </p>

      {/*
        **押す前に書く。** 押してから「古いのが効かなくなりました」と
        知らせても遅い
      */}
      <p className="mt-3 rounded-lg border p-3 text-xs leading-relaxed">
        押すと<strong>新しいファイルが作られます。</strong>
        すでに置いてあるファイルがある場合、それは
        <strong>効かなくなります。</strong>
        新しいほうに置き換えてください。
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        className="mt-4 w-full rounded-lg border p-4 text-base font-bold disabled:opacity-50"
        onClick={() => {
          setBusy(true);
          setError(null);
          setCopied(false);

          void issueLinkSnippet(blogId).then(
            (text) => {
              setBusy(false);
              setSnippet(text);
            },
            (thrown: unknown) => {
              setBusy(false);
              setError(
                thrown instanceof SnippetApiError
                  ? thrown.message
                  : '受け取れませんでした',
              );
            },
          );
        }}
      >
        {busy
          ? '作っています'
          : snippet === null
            ? 'リンク計測のファイルを受け取る'
            : 'もう一度作り直す'}
      </button>

      {snippet === null ? null : (
        <section className="mt-4">
          <h2 className="text-sm font-bold">bunshin-go.php</h2>
          <p className="mt-1 text-xs leading-relaxed">
            この中身を <code>bunshin-go.php</code> という名前で保存し、
            WordPress の <code>{DESTINATION}</code> に置いてください。
            有効化の操作は要りません。
          </p>

          {/*
            **もう一度は出せない。** DBにはハッシュしか無く、
            この画面を離れると二度と見られない
          */}
          <p className="mt-2 text-xs leading-relaxed">
            <strong>この中身が見られるのはいまだけです。</strong>
            閉じると見られなくなります（作り直すことはできます）。
          </p>

          <textarea
            readOnly
            aria-label="bunshin-go.php の中身"
            className="mt-2 h-48 w-full rounded border p-2 font-mono text-xs"
            value={snippet}
          />

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-lg border p-3 text-sm"
              onClick={() => {
                void navigator.clipboard.writeText(snippet).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    // **失敗しても中身は画面に出ている。** 手で選べる
                    setCopied(false);
                    setError(
                      'コピーできませんでした。上の枠から選んで写してください',
                    );
                  },
                );
              }}
            >
              {copied ? 'コピーしました' : 'コピーする'}
            </button>
          </div>
        </section>
      )}

      <p className="mt-6 text-xs leading-relaxed">
        置き方が分からないときは、手引き（
        <code>docs/WORDPRESS_SNIPPET.md</code>）を見てください。
      </p>

      <Link
        href="/liff/onboarding"
        className="mt-4 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
