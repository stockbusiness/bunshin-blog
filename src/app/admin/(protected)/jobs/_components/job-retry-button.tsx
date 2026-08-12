'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 失敗したジョブを積み直すボタン（TASKS H-14、SPEC 13.7）。
 *
 * **中断の印があったかを押した後に伝える。** 印は「外部に副作用が
 * 残っているかもしれない」という意味で、消して積み直した場合は
 * **同じ投稿や送信がもう一度起きうる**（C-4）。黙って成功と出すと、
 * 二重投稿に気づくのが遅れる。
 */

export function JobRetryButton({
  jobId,
  jobType,
}: {
  jobId: string;
  jobType: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setWarning(null);

    try {
      const response = await fetch(`/api/admin/jobs/${jobId}/retry`, {
        method: 'POST',
      });

      const body = (await response.json().catch(() => null)) as {
        message?: unknown;
        clearedCheckpoint?: unknown;
      } | null;

      if (!response.ok) {
        setError(
          typeof body?.message === 'string'
            ? body.message
            : '積み直せませんでした',
        );

        return;
      }

      if (body?.clearedCheckpoint === true) {
        // **消したことを伝える。** 気づかないまま二重投稿になるのを避ける
        setWarning(
          '外部呼び出しの最中に止まった印を消して積み直しました。同じ投稿・送信がもう一度起きる可能性があります。',
        );

        return;
      }

      // 一覧から消えるので読み直す
      router.refresh();
    } catch {
      setError('積み直せませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        aria-label={`${jobType} を積み直す`}
        className="rounded border px-2 py-1 text-xs"
      >
        積み直す
      </button>

      {error === null ? null : (
        <p role="alert" className="text-xs">
          {error}
        </p>
      )}

      {warning === null ? null : (
        <p role="alert" className="text-xs leading-relaxed">
          {warning}
        </p>
      )}
    </div>
  );
}
