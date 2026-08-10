'use client';

import { useEffect, useState } from 'react';
import {
  ResultApiError,
  fetchWeeklyResults,
  saveWeeklyResult,
  type WeeklyResultJson,
} from '../../_lib/results-api';

/**
 * 週次の成果入力（TASKS G-5、SPEC 6.1 `/liff/results`）。
 *
 * 完了条件は「成果件数と報酬額のみ入力。**0件を1操作で記録できる**」。
 *
 * ## 「0件」のボタンを最初に置く
 *
 * 0件の週にわざわざ数字を2つ入れるのは面倒で、**放っておかれる。**
 * すると記録に穴が空き、あとから「成果が無かった」のか
 * 「報告されなかった」のかが分からない。
 *
 * **押すだけで0を記録できるようにする。** 入力欄より前に置く。
 */

function formatWeek(weekStart: string): string {
  const [, month, day] = weekStart.split('-');

  return `${month}/${day}の週`;
}

/**
 * 1週間の状態を1つの文にする。
 *
 * **文を分けて組み立てない。** 要素をまたぐと、読む側（人も試験も）が
 * 「未入力」と「0件」を1つの表示として扱えない。
 */
function summarize(row: WeeklyResultJson): string {
  if (!row.reported) {
    return `${formatWeek(row.weekStart)}：未入力`;
  }

  return `${formatWeek(row.weekStart)}：成果 ${row.conversions}件・${row.revenueYen.toLocaleString()}円`;
}

export function WeeklyResultForm({
  blogId,
  blogName,
}: {
  blogId: string;
  blogName: string;
}) {
  const [results, setResults] = useState<WeeklyResultJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversions, setConversions] = useState('');
  const [revenueYen, setRevenueYen] = useState('');

  // **保存のたびに読み直すための鍵。** 増やすと再取得が走る
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void fetchWeeklyResults(blogId).then(
      (data) => {
        if (!cancelled) setResults(data.results);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
            thrown instanceof ResultApiError
              ? thrown.message
              : '読み込めませんでした',
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [blogId, reloadKey]);

  async function submit(input: { conversions: number; revenueYen: number }) {
    setBusy(true);
    setError(null);

    try {
      await saveWeeklyResult(blogId, input);
      setConversions('');
      setRevenueYen('');
      setReloadKey((key) => key + 1);
    } catch (thrown) {
      setError(
        thrown instanceof ResultApiError ? thrown.message : '保存できません',
      );
    } finally {
      setBusy(false);
    }
  }

  const thisWeek = results?.[0];

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-base font-bold">{blogName}</h2>

      {thisWeek === undefined ? null : (
        <p className="mt-1 text-xs">{summarize(thisWeek)}</p>
      )}

      {/* **0件を1操作で。** 入力欄より前に置く */}
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit({ conversions: 0, revenueYen: 0 })}
        className="mt-3 w-full rounded border px-4 py-3 text-sm font-bold"
      >
        今週は成果0件
      </button>

      <div className="mt-4 flex flex-col gap-2">
        <label className="text-xs">
          成果件数
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={conversions}
            onChange={(event) => setConversions(event.target.value)}
            className="mt-1 w-full rounded border p-2 text-sm"
          />
        </label>

        <label className="text-xs">
          報酬額（円）
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={revenueYen}
            onChange={(event) => setRevenueYen(event.target.value)}
            className="mt-1 w-full rounded border p-2 text-sm"
          />
        </label>

        <button
          type="button"
          disabled={busy || conversions === '' || revenueYen === ''}
          onClick={() =>
            void submit({
              conversions: Number(conversions),
              revenueYen: Number(revenueYen),
            })
          }
          className="rounded border px-4 py-2 text-sm"
        >
          この内容で記録する
        </button>
      </div>

      {error === null ? null : (
        <p className="mt-2 text-sm leading-relaxed">{error}</p>
      )}

      {results === null || results.length === 0 ? null : (
        <details className="mt-4">
          <summary className="text-xs">これまでの記録</summary>
          {/* **未入力と0件を区別して見せる**（`summarize`） */}
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {results.map((row) => (
              <li key={row.weekStart}>{summarize(row)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
