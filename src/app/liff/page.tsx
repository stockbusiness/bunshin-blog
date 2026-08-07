'use client';

import { useLiffSession } from './_components/liff-provider';

/**
 * `/liff` の接続確認画面（TASKS B-8）。
 *
 * **基盤が動いていることを目で確かめるためだけの画面。**
 * SPEC 6.1 の `/liff/home`（3ブログの概要・承認待ち件数など）は別の画面で、
 * まだタスクが立っていない。ここにその内容を作らない。
 */
export default function LiffPage() {
  const session = useLiffSession();

  if (session.status !== 'ready') {
    // レイアウトが ready 以外を描き分けるため、ここへは来ない
    return null;
  }

  return (
    <main className="min-h-dvh p-6">
      <h1 className="text-lg font-bold">LINEログインが完了しました</h1>
      <p className="mt-2 text-sm">{session.user.displayName} さん</p>

      {session.consents.completed ? null : (
        <p className="mt-4 text-sm leading-relaxed">
          ご利用の前に同意が必要な項目があります（
          {session.consents.missing.join('・')}）。
        </p>
      )}
    </main>
  );
}
