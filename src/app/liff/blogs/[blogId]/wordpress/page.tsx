'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { use, useEffect, useId, useState } from 'react';
import { CONNECTION_CHECK_LABELS } from '../../../_lib/labels';
import {
  WordpressApiError,
  connectWordpress,
  fetchWordpressConnection,
  requestAuthorizeUrl,
  testWordpressConnection,
  type ConnectionCheckStatus,
  type ConnectionTestResultJson,
  type WordpressConnectionJson,
} from '../../../_lib/wordpress-api';

/**
 * `/liff/blogs/[blogId]/wordpress` WordPress をつなぐ（段6・C-1/C-2/I-8）。
 *
 * ## なぜ後から足したか
 *
 * **`authorized` の戻り先がこの住所だった。** 承認から戻ると
 * `/liff/blogs/:blogId/wordpress?authorize=connected` へ転送されるのに、
 * **その画面が存在しなかった。** 段6も `/liff/blogs`（一覧）を指していて、
 * 一覧には繋ぐ入口が無い（Q-048）。
 *
 * ## 承認画面を先に出す
 *
 * WordPress の承認画面（I-8）なら、**アプリケーションパスワードを
 * 人が写し取らない。** 手で貼る道も残すが、**畳んでおく** —
 * 先に見せると「32文字の英数字を写す作業」に見えて、そこで止まる。
 *
 * ## 繋いだだけでは段6は済まない
 *
 * 済みの判定は `connectionStatus === 'CONNECTED'` で、**接続テスト
 * （C-2）を通って初めてそうなる。** 繋いだ直後に「終わりました」と
 * 出すと、**済んでいないのに次へ行ってしまう。**
 */

const STATUS_MARKS: Record<ConnectionCheckStatus, string> = {
  PASSED: '○',
  FAILED: '×',
  SKIPPED: '—',
};

/** 承認から戻ったときの結果（`authorized` が付ける） */
const AUTHORIZE_MESSAGES: Record<string, string> = {
  connected:
    'WordPress との接続を保存しました。下の「接続をためす」で確かめてください。',
  rejected: '承認が取り消されました。もう一度お試しください。',
  failed:
    '接続を保存できませんでした。サイトURLが合っているかを確かめてください。',
};

export default function WordpressPage({
  params,
}: {
  params: Promise<{ blogId: string }>;
}) {
  const { blogId } = use(params);
  const searchParams = useSearchParams();
  const siteUrlId = useId();
  const usernameId = useId();
  const passwordId = useId();

  const [connection, setConnection] = useState<WordpressConnectionJson | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [manual, setManual] = useState({ wpUsername: '', appPassword: '' });
  const [result, setResult] = useState<ConnectionTestResultJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchWordpressConnection(blogId).then(
      ({ connection: current }) => {
        if (cancelled) return;

        setConnection(current);
        setLoaded(true);

        // **接続後はURLを変えられない**（Q-007）。読み取り専用で出すため、
        // 保存済みの値をそのまま入れる
        if (current !== null) setSiteUrl(current.siteUrl);
      },
      (thrown: unknown) => {
        if (cancelled) return;

        setLoaded(true);
        setError(
          thrown instanceof WordpressApiError
            ? thrown.message
            : '読み込めませんでした',
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [blogId]);

  if (!loaded) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const authorizeOutcome = searchParams.get('authorize');
  const authorizeMessage =
    authorizeOutcome === null
      ? undefined
      : AUTHORIZE_MESSAGES[authorizeOutcome];

  // **保存されているかと、確かめたかは別**（段6の済みは後者）
  const saved = connection !== null && connection.hasCredentials;
  const verified = connection?.connectionStatus === 'CONNECTED';

  function handle(promise: Promise<unknown>): void {
    setBusy(true);
    setError(null);

    void promise.then(
      () => {
        setBusy(false);
      },
      (thrown: unknown) => {
        setBusy(false);
        setError(
          thrown instanceof WordpressApiError
            ? thrown.message
            : '処理できませんでした',
        );
      },
    );
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">WordPress をつなぐ</h1>

      {authorizeMessage === undefined ? null : (
        <p
          role="status"
          className="mt-3 rounded-lg border p-3 text-sm leading-relaxed"
        >
          {authorizeMessage}
        </p>
      )}

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {error}
        </p>
      )}

      {saved ? (
        <section className="mt-4 rounded-lg border p-4">
          <p className="text-sm font-bold">つないでいるサイト</p>
          <p className="mt-1 break-all text-xs">{connection.siteUrl}</p>
          <p className="mt-2 text-xs leading-relaxed">
            {verified
              ? '接続を確かめました。この段は済んでいます'
              : 'まだ確かめていません。下の「接続をためす」を押してください'}
          </p>
          {/*
            **URLは繋いだ後に変えられない**（Q-007）。押せるように
            見せてから断らない
          */}
          <p className="mt-2 text-xs leading-relaxed">
            サイトを変えるときは、このブログを終了して作り直します
          </p>
        </section>
      ) : (
        <section className="mt-4 flex flex-col gap-3">
          <p className="text-sm leading-relaxed">
            WordPress の画面で承認すると、パスワードを写さずにつなげます。
          </p>

          <div className="flex flex-col gap-1">
            <label htmlFor={siteUrlId} className="text-sm font-bold">
              サイトのURL
            </label>
            <input
              id={siteUrlId}
              className="rounded border p-2 text-base"
              value={siteUrl}
              maxLength={255}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://example.com"
              onChange={(event) => {
                setSiteUrl(event.target.value);
              }}
            />
          </div>

          <button
            type="button"
            disabled={busy || siteUrl.trim() === ''}
            className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
            onClick={() => {
              handle(
                requestAuthorizeUrl(blogId, siteUrl.trim()).then(
                  ({ authorizeUrl }) => {
                    // **サーバーから転送しない**（I-8）。戻り先を
                    // 画面が持つため、開くのはここ
                    window.location.assign(authorizeUrl);
                  },
                ),
              );
            }}
          >
            WordPress で承認する
          </button>

          {/*
            **手で貼る道は畳んでおく。** 先に見せると「32文字を写す作業」に
            見えて、そこで止まる。承認画面が出ないサイトのための逃げ道
          */}
          <details className="rounded-lg border p-4">
            <summary className="text-sm">承認の画面が出ないとき</summary>

            <p className="mt-3 text-xs leading-relaxed">
              WordPress の「ユーザー」→「プロフィール」→「アプリケーション
              パスワード」で発行し、そのまま貼り付けてください。空白は
              入ったままで構いません。
            </p>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor={usernameId} className="text-sm font-bold">
                WordPress のユーザー名
              </label>
              <input
                id={usernameId}
                className="rounded border p-2 text-base"
                value={manual.wpUsername}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => {
                  setManual({ ...manual, wpUsername: event.target.value });
                }}
              />
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor={passwordId} className="text-sm font-bold">
                アプリケーションパスワード
              </label>
              <input
                id={passwordId}
                type="password"
                className="rounded border p-2 text-base"
                value={manual.appPassword}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => {
                  setManual({ ...manual, appPassword: event.target.value });
                }}
              />
            </div>

            <button
              type="button"
              disabled={
                busy ||
                siteUrl.trim() === '' ||
                manual.wpUsername.trim() === '' ||
                manual.appPassword === ''
              }
              className="mt-3 w-full rounded-lg border p-4 text-base font-bold disabled:opacity-50"
              onClick={() => {
                handle(
                  connectWordpress(blogId, {
                    siteUrl: siteUrl.trim(),
                    wpUsername: manual.wpUsername.trim(),
                    appPassword: manual.appPassword,
                  }).then(({ connection: saved_ }) => {
                    setConnection(saved_);
                    // **貼った値を残さない**（SPEC 14.2）
                    setManual({ wpUsername: '', appPassword: '' });
                  }),
                );
              }}
            >
              貼り付けてつなぐ
            </button>
          </details>
        </section>
      )}

      {saved ? (
        <button
          type="button"
          disabled={busy}
          className="mt-4 w-full rounded-lg border p-4 text-base font-bold disabled:opacity-50"
          onClick={() => {
            handle(
              testWordpressConnection(blogId).then(({ result: tested }) => {
                setResult(tested);

                // テストの結果で状態が変わる。**聞き直して出し直す**
                return fetchWordpressConnection(blogId).then(
                  ({ connection: current }) => {
                    setConnection(current);
                  },
                );
              }),
            );
          }}
        >
          {busy ? '試しています' : '接続をためす'}
        </button>
      ) : null}

      {result === null ? null : (
        <section className="mt-4">
          <p className="text-sm font-bold">
            {result.ok ? '7項目すべて通りました' : '通らなかった項目があります'}
          </p>

          <ul className="mt-2 flex flex-col gap-1">
            {result.checks.map((check) => (
              <li key={check.id} className="text-xs leading-relaxed">
                {STATUS_MARKS[check.status]} {CONNECTION_CHECK_LABELS[check.id]}
                {check.message === null ? null : `：${check.message}`}
              </li>
            ))}
          </ul>

          {/*
            **消せなかったテスト投稿は必ず伝える。** 黙っていると、
            身に覚えのない下書きがブログに残る
          */}
          {result.leftoverPostId === null ? null : (
            <p className="mt-2 text-xs leading-relaxed">
              テスト用の下書きが消せませんでした。WordPress
              の下書きに「【BUNSHIN BLOG】接続テスト」が残っていたら、
              削除してください。
            </p>
          )}
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
