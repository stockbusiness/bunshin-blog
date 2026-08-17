'use client';

import { useState } from 'react';
import {
  NOT_OUR_BLOG,
  ResultApiError,
  previewResultCsv,
  registerResultCsv,
  type ResultCsvPreviewJson,
} from '../../_lib/results-api';

/**
 * ASPの成果レポート（CSV）を上げて、週ごとの成果を記録する（Q-059・Q-058）。
 *
 * ## 打つのは0
 *
 * 数字を2つ打つ代わりに、**ASPで書き出したCSVを選ぶだけ。**
 * 列の対応づけも、週へのまとめも、こちらでやる。
 * **残るのは「この内容でよいか」の1回だけ**（Q-058 の最終GO）。
 *
 * ## 書き込む前に必ず見せる
 *
 * これは90日の実験の一次データで、**あとから静かに直せない。**
 * まとめた結果を出し、**人が見てから**書き込む。
 *
 * ## 分からない行は聞く
 *
 * ASPのアカウントには**この実験の外のサイトの成果**も入りうる。
 * 案件名から決められなかったものだけ、どのブログか選んでもらう。
 * **選び終わるまで記録させない** — 取りこぼしが「0件」として残るため。
 */

const SELECT = 'rounded-lg border p-2 text-sm';

function messageOf(thrown: unknown): string {
  return thrown instanceof ResultApiError
    ? thrown.message
    : '読み取れませんでした';
}

/** バイト列をBase64にする。**一度に広げない**（5MBまで受け付ける） */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 8_192;
  let binary = '';

  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }

  return btoa(binary);
}

function formatWeek(weekStart: string): string {
  const [, month, day] = weekStart.split('-');

  return `${month}/${day}の週`;
}

export function ResultCsvImport({ onSaved }: { onSaved: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResultCsvPreviewJson | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function run(action: () => Promise<void>): void {
    setBusy(true);
    setError(null);

    void action()
      .catch((thrown: unknown) => {
        setError(messageOf(thrown));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function choose(file: File): void {
    setPreview(null);
    setAssignments({});
    setDone(null);

    run(async () => {
      const encoded = toBase64(new Uint8Array(await file.arrayBuffer()));

      setCsv(encoded);
      setPreview(await previewResultCsv({ csv: encoded }));
    });
  }

  /** 割り当てを変えたら、**その場でまとめ直して見せる**（AIは呼ばない） */
  function assign(key: string, blogId: string): void {
    const next = { ...assignments, [key]: blogId };

    setAssignments(next);

    if (csv === null || preview === null) {
      return;
    }

    run(async () => {
      setPreview(
        await previewResultCsv({
          csv,
          mapping: preview.mapping,
          assignments: next,
        }),
      );
    });
  }

  const summary = preview?.summary;
  const ready =
    csv !== null &&
    preview !== null &&
    summary !== undefined &&
    summary.unassigned.length === 0 &&
    summary.weekStarts.length > 0;

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-base font-bold">CSVから記録する</h2>
      <p className="mt-1 text-xs leading-relaxed">
        ASPの管理画面で<strong>成果レポートをCSVで書き出して</strong>
        選んでください。<strong>数字を打つ必要はありません</strong>
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="成果レポートのCSV"
        disabled={busy}
        className="mt-3 w-full text-xs"
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file !== undefined) {
            choose(file);
          }
        }}
      />

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {error}
        </p>
      )}

      {done === null ? null : (
        <p role="status" className="mt-3 text-sm leading-relaxed">
          {done}
        </p>
      )}

      {busy ? <p className="mt-3 text-xs">読み取っています…</p> : null}

      {summary === undefined ? null : (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-xs leading-relaxed">
            {summary.totalRows} 行を読みました。
            {summary.weekStarts.length === 0
              ? '記録できる成果が見つかりませんでした'
              : `${formatWeek(summary.weekStarts[0] as string)}から${summary.weekStarts.length} 週ぶんです`}
          </p>

          {summary.blogs.map((blog) => (
            <div key={blog.blogId} className="rounded-lg border p-3">
              <p className="text-sm font-bold">{blog.blogName}</p>
              <p className="mt-1 text-xs">
                成果 {blog.conversions} 件・
                {blog.revenueYen.toLocaleString('ja-JP')} 円
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {blog.weeks.map((week) => (
                  <li key={week.weekStart}>
                    {formatWeek(week.weekStart)}：{week.conversions} 件・
                    {week.revenueYen.toLocaleString('ja-JP')} 円
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/*
           **分からない行は聞く。** 推測で入れると90日の一次データが狂う
           */}
          {summary.unassigned.length === 0 ? null : (
            <div className="rounded-lg border p-3">
              <p className="text-sm font-bold">どのブログの成果ですか</p>
              <p className="mt-1 text-xs leading-relaxed">
                登録済みの案件と名前が合わなかったものです。
                <strong>この実験と関係ない成果なら「数えない」</strong>
                を選んでください
              </p>

              <ul className="mt-2 flex flex-col gap-2">
                {summary.unassigned.map((group) => (
                  <li key={group.key} className="flex flex-col gap-1">
                    <label className="text-xs">
                      {group.offerName === ''
                        ? '案件名が空の行'
                        : group.offerName}
                      （{group.rows} 件・
                      {group.revenueYen.toLocaleString('ja-JP')} 円）
                      <select
                        className={`${SELECT} mt-1 w-full`}
                        disabled={busy}
                        value={assignments[group.key] ?? ''}
                        onChange={(event) => {
                          if (event.target.value !== '') {
                            assign(group.key, event.target.value);
                          }
                        }}
                      >
                        <option value="">選んでください</option>
                        {summary.blogs.map((blog) => (
                          <option key={blog.blogId} value={blog.blogId}>
                            {blog.blogName}
                          </option>
                        ))}
                        <option value={NOT_OUR_BLOG}>
                          この実験のブログではない（数えない）
                        </option>
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* **黙って落とさない**（数えなかった行を出す） */}
          {summary.rejectedRows === 0 &&
          summary.unreadable.length === 0 ? null : (
            <p className="text-xs leading-relaxed">
              {summary.rejectedRows === 0
                ? ''
                : `否認・キャンセルの ${summary.rejectedRows} 行は数えていません。`}
              {summary.unreadable.length === 0
                ? ''
                : `日付を読めなかった ${summary.unreadable.length} 行は使っていません。`}
            </p>
          )}

          <button
            type="button"
            disabled={busy || !ready}
            className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
            onClick={() => {
              if (csv === null || preview === null) {
                return;
              }

              setDone(null);

              run(async () => {
                const result = await registerResultCsv({
                  csv,
                  mapping: preview.mapping,
                  assignments,
                });

                setPreview(null);
                setCsv(null);
                setAssignments({});
                setDone(`${result.savedWeeks} 週ぶんを記録しました`);
                onSaved();
              });
            }}
          >
            {busy ? '記録しています' : 'この内容で記録する'}
          </button>
        </div>
      )}
    </section>
  );
}
