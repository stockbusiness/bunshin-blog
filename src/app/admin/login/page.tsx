'use client';

import { useState } from 'react';

/**
 * `/admin/login` ログインリンクの要求（TASKS B-11、SPEC 3.2）。
 *
 * **`(protected)` の外に置く。** ログイン前の画面を認証の内側に入れると、
 * ログインするためにログインが要ることになる。
 *
 * **結果を出し分けない。** 「そのアドレスは登録されていません」と返すと、
 * どのアドレスが管理者かを外から調べられる。
 */

const ACCEPTED_MESSAGE =
  '登録済みの管理者アドレスであれば、ログインリンクを送信しました。メールをご確認ください';

export default function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailed(false);

    try {
      await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // 応答の内容は見ない。サーバー側も常に同じ結果を返す
      setDone(true);
    } catch {
      // 通信そのものに失敗した場合だけ、やり直せることを伝える
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col justify-center bg-slate-50 p-6">
      <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          管理画面へのログイン
        </h1>

        {done ? (
          <p className="mt-6 text-sm leading-relaxed text-slate-700">
            {ACCEPTED_MESSAGE}
          </p>
        ) : (
          <form
            onSubmit={(e) => void submit(e)}
            className="mt-6 flex flex-col gap-4"
          >
            <label
              htmlFor="email"
              className="text-sm font-medium text-slate-700"
            >
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-slate-900"
            />

            <button
              type="submit"
              disabled={sending}
              className="rounded-lg bg-slate-900 p-4 text-base font-bold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? '送信しています' : 'ログインリンクを送る'}
            </button>

            {failed ? (
              <p role="alert" className="text-sm leading-relaxed text-red-700">
                通信に失敗しました。時間をおいてお試しください
              </p>
            ) : null}
          </form>
        )}

        <p className="mt-8 text-xs leading-relaxed text-slate-500">
          リンクは15分間、1回だけ使えます。
        </p>
      </div>
    </main>
  );
}
