'use client';

import { useId, useState } from 'react';
import { BUTTON_PRIMARY, HINT, INPUT } from '../../_components/ui';

/**
 * ジャンル審査の入力（Q-049、SPEC 9.2.2）。
 *
 * ## 検索上位の内訳を手で入れる
 *
 * **取得する仕組みがどこにも無い。** `judgeGenre` は空を拒む
 * （「取得できないことを理由に停止条件をスキップしない」）。
 * SPEC 9.2.2 のフォールバック「ADMINの手動入力値を使う」を正面から使う。
 *
 * **10件ちょうどを強制しない。** 数えられた分だけで判定する
 * （入口は1〜10件を受け取る）。**足りないから飛ばす、をしない。**
 */

const DOMAIN_TYPES = [
  { key: 'official', label: '公式サイト' },
  { key: 'major_comparison', label: '大手比較サイト' },
  { key: 'personal', label: '個人ブログ' },
  { key: 'other', label: 'その他' },
] as const;

type DomainType = (typeof DOMAIN_TYPES)[number]['key'];

export interface GenreOption {
  id: string;
  name: string;
  category: string;
  ymylRisk: string;
}

export interface ReviewOutcome {
  decision: 'PASSED' | 'WARNED' | 'BLOCKED';
  reasons: string[];
  canOverride: boolean;
  genre: { name: string } | null;
  alternatives: { name: string; category: string }[];
}

const DECISION_LABELS: Record<ReviewOutcome['decision'], string> = {
  PASSED: '通りました',
  WARNED: '警告つきで通りました',
  BLOCKED: '止まりました',
};

export function GenreReviewForm({
  blogId,
  genres,
}: {
  blogId: string;
  genres: GenreOption[];
}) {
  const genreId = useId();
  const experienceId = useId();

  const [selected, setSelected] = useState('');
  const [counts, setCounts] = useState<Record<DomainType, number>>({
    official: 0,
    major_comparison: 0,
    personal: 0,
    other: 0,
  });
  const [hasExperience, setHasExperience] = useState(false);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = DOMAIN_TYPES.reduce((sum, type) => sum + counts[type.key], 0);
  const canSubmit = !busy && selected !== '' && total >= 1 && total <= 10;

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">ジャンル審査</h2>
      <p className={`mt-1 ${HINT}`}>
        検索上位10件の内訳を数えて入れてください。取得する仕組みが無いため、
        ここは手で入れます（SPEC 9.2.2 のフォールバック）。
      </p>

      <div className="mt-4 flex flex-col gap-1">
        <label htmlFor={genreId} className="text-sm font-medium text-slate-700">
          ジャンル
        </label>
        <select
          id={genreId}
          className={INPUT}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setOutcome(null);
          }}
        >
          <option value="">選んでください</option>
          {genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.category}／{genre.name}
              {genre.ymylRisk === 'HIGH' ? '（YMYL）' : ''}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-slate-700">
          検索上位の内訳
        </legend>
        <div className="mt-2 flex flex-col gap-2">
          {DOMAIN_TYPES.map((type) => (
            <label key={type.key} className="flex items-center gap-2 text-sm">
              <span className="w-32">{type.label}</span>
              <input
                type="number"
                min={0}
                max={10}
                className={`${INPUT} w-20`}
                value={counts[type.key]}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);

                  setCounts({
                    ...counts,
                    [type.key]:
                      Number.isInteger(value) && value >= 0 ? value : 0,
                  });
                  setOutcome(null);
                }}
              />
            </label>
          ))}
        </div>
        <p className={`mt-2 ${HINT}`}>合計 {total} 件（1〜10件）</p>
      </fieldset>

      <label
        htmlFor={experienceId}
        className="mt-4 flex items-center gap-2 text-sm"
      >
        <input
          id={experienceId}
          type="checkbox"
          checked={hasExperience}
          onChange={(event) => {
            setHasExperience(event.target.checked);
            setOutcome(null);
          }}
        />
        モニターに利用経験がある
      </label>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        className={`mt-4 ${BUTTON_PRIMARY}`}
        onClick={() => {
          setBusy(true);
          setError(null);

          const serpTop10 = DOMAIN_TYPES.flatMap((type) =>
            Array.from({ length: counts[type.key] }, () => ({
              domainType: type.key,
            })),
          );

          void fetch(`/api/admin/blogs/${blogId}/genre-review`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              genreId: selected,
              serpTop10,
              userHasExperience: hasExperience,
            }),
          })
            .then(async (response) => {
              const body: unknown = await response.json();

              if (!response.ok) {
                throw new Error(
                  (body as { error?: { message?: string } }).error?.message ??
                    '審査できませんでした',
                );
              }

              setOutcome(body as ReviewOutcome);
            })
            .catch((thrown: unknown) => {
              setError(
                thrown instanceof Error
                  ? thrown.message
                  : '審査できませんでした',
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {busy ? '審査しています' : '審査する'}
      </button>

      {outcome === null ? null : (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-700">
            {DECISION_LABELS[outcome.decision]}
          </p>

          {outcome.reasons.length === 0 ? null : (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {outcome.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          {/*
            **止まったときは付けない。** 付けると、停止条件を満たす
            ジャンルでブログが動き出す
          */}
          <p className="mt-2 text-xs">
            {outcome.genre === null
              ? 'ジャンルは付けていません'
              : `ブログに「${outcome.genre.name}」を付けました`}
          </p>

          {outcome.alternatives.length === 0 ? null : (
            <p className="mt-2 text-xs">
              別の候補：
              {outcome.alternatives
                .map((item) => `${item.category}／${item.name}`)
                .join('、')}
            </p>
          )}

          {outcome.canOverride ? (
            <p className="mt-2 text-xs">
              差し戻しが2回に達しています。「リスクを理解して進める」を選べる
              段階です（SPEC 9.2.2）。
              <strong>その入口はまだありません。</strong>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
