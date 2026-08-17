'use client';

import { useEffect, useState } from 'react';
import {
  OfferApiError,
  createOfferFromCatalog,
  fetchOfferCatalog,
  type CatalogItemJson,
  type OfferJson,
  type UserExperience,
} from '../../../../_lib/offers-api';

/**
 * 運営が用意した案件から選ぶ（Q-058・Q-055、段8）。
 *
 * ## 打つのは1つだけ
 *
 * 案件を選べば、名前・ASP・紹介先・成果条件・事実は**カタログから入る。**
 * **打つのはアフィリエイトリンクだけ**（本人のASPアカウントのもので、
 * 代われない）。
 *
 * ## リンクは後からでよい
 *
 * **提携が承認されるまでリンクは発行できない**（Q-060）。承認を待つ間に
 * 登録できないと、モニターは**「あの案件を申請した」ことを覚えておくしかない。**
 * 提携が承認されていない案件は**記事候補に入らない**ので、
 * 先に登録しても記事にはならない。
 *
 * ## 使ったことがあるかは省けない
 *
 * **ここで記事の書き方が変わる**（`docs/MANUAL.md` 段8）。
 * 使っていないものを「使ってみました」とは書かない。
 * **本人にしか答えられない。**
 *
 * ## 事実を打たせない
 *
 * カタログの事実は**運営が確かめたもの。** 画面には出すが、
 * **モニターに打ち直させない**（打たせると、確かめた記録の意味が薄れる）。
 */

const EXPERIENCE_LABELS: { value: UserExperience; label: string }[] = [
  { value: 'USED', label: '使ったことがある' },
  { value: 'NOT_USED', label: '使ったことがない' },
  { value: 'UNKNOWN', label: 'わからない' },
];

const CONVERSION_LABELS: Record<string, string> = {
  FREE_SIGNUP: '無料登録',
  REQUEST: '資料請求',
  TRIAL: '無料体験',
  PURCHASE: '購入',
  OTHER: 'そのほか',
};

function messageOf(thrown: unknown): string {
  return thrown instanceof OfferApiError
    ? thrown.message
    : '保存できませんでした';
}

export function CatalogPicker({
  blogId,
  onAdded,
}: {
  blogId: string;
  onAdded: (offer: OfferJson) => void;
}) {
  const [items, setItems] = useState<CatalogItemJson[] | null>(null);
  const [chosen, setChosen] = useState<CatalogItemJson | null>(null);
  const [affiliateUrl, setAffiliateUrl] = useState('');
  const [applied, setApplied] = useState(false);
  const [experience, setExperience] = useState<UserExperience | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchOfferCatalog(blogId).then(
      (loaded) => {
        if (!cancelled) {
          setItems(loaded.items);
        }
      },
      () => {
        // **読めなくても手入力の道は残る。** ここで画面を止めない
        if (!cancelled) {
          setItems([]);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [blogId]);

  if (items === null) {
    return <p className="mt-4 text-xs">候補を読み込んでいます…</p>;
  }

  if (items.length === 0) {
    return (
      <p className="mt-4 text-xs leading-relaxed">
        いま選べる案件がありません。下の
        <strong>「じぶんで入力する」</strong>から登録してください。
      </p>
    );
  }

  // **リンクは無くてもよい**（Q-060）。提携が承認されるまで発行できない
  const ready = chosen !== null && experience !== '';

  return (
    <section className="mt-4 flex flex-col gap-3">
      <h2 className="text-sm font-bold">候補から選ぶ（{items.length} 件）</h2>
      <p className="text-xs leading-relaxed">
        <strong>入れるのはアフィリエイトリンクだけです。</strong>
        名前や事実は登録済みのものが入ります。
        <strong>提携がまだでも、先に登録できます</strong>
      </p>

      {error === null ? null : (
        <p role="alert" className="text-sm leading-relaxed">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((item) => {
          const picked = chosen?.id === item.id;

          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={picked}
                className={`w-full rounded-lg border p-3 text-left ${
                  picked ? 'border-2 font-bold' : ''
                }`}
                onClick={() => {
                  setChosen(picked ? null : item);
                  setError(null);
                }}
              >
                <span className="block text-sm font-bold">{item.name}</span>
                <span className="mt-1 block text-xs">
                  {item.aspName}・
                  {CONVERSION_LABELS[item.conversionType] ??
                    item.conversionType}
                  {item.rewardYen === null
                    ? ''
                    : `・${item.rewardYen.toLocaleString('ja-JP')} 円`}
                </span>
                {/*
                  **事実は見せるが打たせない。** 運営が確かめたもので、
                  打ち直させると確かめた記録の意味が薄れる
                */}
                <span className="mt-1 block text-xs">
                  {item.facts.length === 0
                    ? '事実が未記入です'
                    : `事実 ${item.facts.length} 件：${item.facts.slice(0, 2).join('／')}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {chosen === null ? null : (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <p className="text-sm font-bold">{chosen.name}</p>

          <label className="flex flex-col gap-1 text-sm font-bold">
            アフィリエイトリンク
            <input
              className="rounded-lg border p-3 text-base"
              value={affiliateUrl}
              onChange={(event) => {
                setAffiliateUrl(event.target.value);
              }}
            />
            <span className="text-xs leading-relaxed">
              ASPの管理画面でこの案件のリンクを発行して貼ってください。
              <strong>ここだけは代われません</strong>
              （成果があなたに付くため）。
              <strong>提携がまだなら空のままで構いません</strong>
            </span>
          </label>

          {/*
            **提携が承認されるまでリンクは発行できない**（Q-060）。
            申請したかどうかは**本人にしか分からない**ので、そこだけ聞く
          */}
          {affiliateUrl.trim() === '' ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={applied}
                onChange={(event) => {
                  setApplied(event.target.checked);
                }}
              />
              ASPに申請して、返事を待っています
            </label>
          ) : null}

          {/*
            **省けない。** ここで記事の書き方が変わる（MANUAL 段8）。
            使っていないものを「使ってみました」とは書かない
          */}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-bold">自分で使ったことは？</legend>
            <div className="mt-1 flex flex-col gap-1">
              {EXPERIENCE_LABELS.map((entry) => (
                <label
                  key={entry.value}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="experience"
                    value={entry.value}
                    checked={experience === entry.value}
                    onChange={() => {
                      setExperience(entry.value);
                    }}
                  />
                  {entry.label}
                </label>
              ))}
            </div>
            <span className="text-xs leading-relaxed">
              <strong>ここで記事の書き方が変わります。</strong>
              使っていないものを「使ってみました」とは書きません
            </span>
          </fieldset>

          <button
            type="button"
            disabled={busy || !ready}
            className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
            onClick={() => {
              if (experience === '') {
                return;
              }

              setBusy(true);
              setError(null);

              void createOfferFromCatalog(blogId, {
                catalogItemId: chosen.id,
                userExperience: experience,
                // **空なら送らない**（Q-060）
                ...(affiliateUrl.trim() === ''
                  ? { applied }
                  : { affiliateUrl: affiliateUrl.trim() }),
              }).then(
                (result) => {
                  setBusy(false);
                  onAdded(result.offer);
                  // **続けて選べるようにする。** 1件ごとに開き直させない
                  setChosen(null);
                  setAffiliateUrl('');
                  setApplied(false);
                  setExperience('');
                },
                (thrown: unknown) => {
                  setBusy(false);
                  setError(messageOf(thrown));
                },
              );
            }}
          >
            {busy ? '登録しています' : 'この案件を登録する'}
          </button>
        </div>
      )}
    </section>
  );
}
