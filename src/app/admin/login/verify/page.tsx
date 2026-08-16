/**
 * `/admin/login/verify` メールのリンク先（TASKS B-11）。
 *
 * **この画面はトークンを使わない。** ボタンを押したときに
 * `POST /api/admin/login/verify` を叩く。
 *
 * 理由：メールのリンクを開いただけで消費すると、受信側のセキュリティ製品や
 * クライアントの先読みでトークンが使われ、本人がクリックしたときには
 * 使用済みになる。**GETで状態を変えない。**
 */

export const dynamic = 'force-dynamic';

export default async function AdminLoginVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (token === undefined || token === '') {
    return (
      <main className="flex min-h-dvh flex-col justify-center bg-slate-50 p-6">
        <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            ログイン
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            リンクが正しくありません。ログインをやり直してください。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center bg-slate-50 p-6">
      <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          ログイン
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-700">
          下のボタンを押すと管理画面へ進みます。
        </p>

        <form
          action="/api/admin/login/verify"
          method="post"
          className="mt-6 flex flex-col gap-4"
        >
          {/* トークンは画面に出さず、送信だけに使う */}
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="rounded-lg bg-slate-900 p-4 text-base font-bold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            ログインする
          </button>
        </form>

        <p className="mt-8 text-xs leading-relaxed text-slate-500">
          このリンクは1回だけ使えます。
        </p>
      </div>
    </main>
  );
}
