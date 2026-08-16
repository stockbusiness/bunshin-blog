'use client';

import { useId, useState } from 'react';
import { BUTTON_PRIMARY, HINT, INPUT } from '../../_components/ui';

/**
 * ジャンルを足す（Q-049）。
 *
 * ## 2階層で入れる
 *
 * | 欄 | 粒度 | 使い道 |
 * |---|---|---|
 * | 分類 | 粗い | **`ymylRisk` の単位**・ジャンル別の集計 |
 * | 名前 | 細かい | **AIに渡す言葉**（STEP 2/4 のキーワード・検索意図） |
 *
 * **記事本文の生成にジャンルは渡っていない。** 細かくして効くのは
 * 題材選びであって、書きぶりではない。
 *
 * **同じ分類の中で `ymylRisk` が食い違うと、サーバーが弾く。**
 * 1つ付け忘れると、そこだけ停止条件を素通りする。
 */

const YMYL_RISKS = [
  { key: 'LOW', label: '低い' },
  { key: 'MEDIUM', label: '中くらい' },
  { key: 'HIGH', label: '高い（YMYL・無条件で停止）' },
] as const;

export function GenreCreateForm() {
  const nameId = useId();
  const categoryId = useId();
  const riskId = useId();

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [ymylRisk, setYmylRisk] = useState<string>('LOW');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = !busy && name.trim() !== '' && category.trim() !== '';

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">ジャンルを足す</h2>
      <p className={`mt-1 ${HINT}`}>
        分類は粗く（集計とYMYLの単位）、名前は細かく（AIに渡す言葉）。
        同じ分類の中では YMYL を揃えてください。
      </p>

      <div className="mt-4 flex flex-col gap-1">
        <label
          htmlFor={categoryId}
          className="text-sm font-medium text-slate-700"
        >
          分類（粗い）
        </label>
        <input
          id={categoryId}
          className={INPUT}
          value={category}
          maxLength={100}
          placeholder="通信"
          onChange={(event) => {
            setCategory(event.target.value);
          }}
        />
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium text-slate-700">
          名前（細かい）
        </label>
        <input
          id={nameId}
          className={INPUT}
          value={name}
          maxLength={100}
          placeholder="格安SIM"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor={riskId} className="text-sm font-medium text-slate-700">
          YMYL リスク
        </label>
        <select
          id={riskId}
          className={INPUT}
          value={ymylRisk}
          onChange={(event) => {
            setYmylRisk(event.target.value);
          }}
        >
          {YMYL_RISKS.map((risk) => (
            <option key={risk.key} value={risk.key}>
              {risk.label}
            </option>
          ))}
        </select>
      </div>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {message === null ? null : (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {message}
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        className={`mt-4 ${BUTTON_PRIMARY}`}
        onClick={() => {
          setBusy(true);
          setError(null);
          setMessage(null);

          void fetch('/api/admin/genres', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              category: category.trim(),
              ymylRisk,
            }),
          })
            .then(async (response) => {
              const body: unknown = await response.json();

              if (!response.ok) {
                throw new Error(
                  (body as { error?: { message?: string } }).error?.message ??
                    '足せませんでした',
                );
              }

              setMessage(
                `「${name.trim()}」を足しました。画面を開き直すと一覧に出ます`,
              );
              setName('');
            })
            .catch((thrown: unknown) => {
              setError(
                thrown instanceof Error ? thrown.message : '足せませんでした',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {busy ? '足しています' : '足す'}
      </button>
    </section>
  );
}
