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
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
        <h1 className="text-lg font-bold">ログイン</h1>
        <p className="mt-4 text-sm leading-relaxed">
          リンクが正しくありません。ログインをやり直してください。
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <h1 className="text-lg font-bold">ログイン</h1>
      <p className="mt-4 text-sm leading-relaxed">
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
          className="rounded bg-black p-4 text-base font-bold text-white"
        >
          ログインする
        </button>
      </form>

      <p className="mt-8 text-xs leading-relaxed">
        このリンクは1回だけ使えます。
      </p>
    </main>
  );
}
