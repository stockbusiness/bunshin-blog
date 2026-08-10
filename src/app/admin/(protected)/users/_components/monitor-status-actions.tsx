'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * モニターの状態を変えるボタン（TASKS H-1、SPEC 6.2）。
 *
 * **今の状態で意味のある操作だけを出す。** 押せるが何も起きない
 * ボタンを並べると、押した人は「効かなかった」のか「もともと不要」
 * なのか分からない。
 *
 * **退会のボタンは置かない**（H-4）。戻せない操作を、停止と同じ並びに
 * 置くと、停止のつもりで退会させる事故が起きる。
 */

export type MonitorAction = 'ACTIVATE' | 'PAUSE' | 'RESUME';

const LABELS: Readonly<Record<MonitorAction, string>> = {
  ACTIVATE: '参加を承認する',
  PAUSE: '利用を停止する',
  RESUME: '利用を再開する',
};

/** その状態で出す操作。`WITHDRAWN` には何も出さない */
function actionsFor(status: string): MonitorAction[] {
  if (status === 'INVITED') {
    return ['ACTIVATE'];
  }

  if (status === 'ACTIVE') {
    return ['PAUSE'];
  }

  if (status === 'PAUSED') {
    return ['RESUME'];
  }

  return [];
}

export function MonitorStatusActions({
  userId,
  status,
  displayName,
}: {
  userId: string;
  status: string;
  displayName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = actionsFor(status);

  if (actions.length === 0) {
    return null;
  }

  async function run(action: MonitorAction) {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;

        setError(
          typeof body?.message === 'string'
            ? body.message
            : '変更できませんでした',
        );

        return;
      }

      // **画面を読み直す。** 状態は一覧の他の列（同意・ブログ）とも
      // 並べて見るもので、ここだけ書き換えると食い違う
      router.refresh();
    } catch {
      setError('変更できませんでした');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          disabled={busy}
          onClick={() => void run(action)}
          aria-label={`${displayName} の${LABELS[action]}`}
          className="rounded border px-2 py-1 text-xs"
        >
          {LABELS[action]}
        </button>
      ))}

      {error === null ? null : <p className="text-xs">{error}</p>}
    </div>
  );
}
