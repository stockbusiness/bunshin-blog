'use client';

import Link from 'next/link';
import { use, useEffect, useId, useState } from 'react';
import {
  CONVERSION_TYPE_LABELS,
  CONVERSION_TYPE_VALUES,
  OFFER_STATUS_LABELS,
  USER_EXPERIENCE_LABELS,
  USER_EXPERIENCE_VALUES,
} from '../../../_lib/labels';
import {
  OfferApiError,
  createOffer,
  draftOffer,
  fetchOffers,
  readFactItems,
  type ConversionType,
  type CreateOfferInput,
  type OfferJson,
  type UserExperience,
} from '../../../_lib/offers-api';

/**
 * `/liff/blogs/[blogId]/offers` 案件を登録する（段8・D-1/I-3）。
 *
 * ## なぜ後から足したか
 *
 * **I-3 の完了条件は「オンボーディング STEP 8（案件登録）が画面から
 * 完了できる」だった。** 入口（`/api/blogs/:blogId/offers`）は作られたが、
 * **呼ぶ画面が無いまま完了とされていた**（Q-048）。
 *
 * ## 聞かないこと
 *
 * **`linkMode` `subIdParam` `blogPostingProhibited` は聞かない**
 * （Q-001・Q-014・Q-019）。ASPの規約に関わる判断で、**誤ると成果が
 * 無効になる。** ADMIN が運用で設定する。入口も受け取らない。
 *
 * ## 必須は5つだけ
 *
 * 報酬額と「使ったことがあるか」は**省ける**。段4で入力の多さに実際に
 * 詰まった（Q-047）ので、**最初の1件を登録するまでを短くする。**
 *
 * ただし**「使ったことがあるか」は既定を `UNKNOWN` にしない。**
 * 記事の書き方が変わる（SPEC 9.6）ので、**選ばせる。**
 */

interface FormState {
  name: string;
  aspName: string;
  landingPageUrl: string;
  affiliateUrl: string;
  conversionType: ConversionType;
  rewardYen: string;
  /** 1行に1つ。送るときに配列へ均す */
  facts: string;
  userExperience: UserExperience | '';
}

const EMPTY_FORM: FormState = {
  name: '',
  aspName: '',
  landingPageUrl: '',
  affiliateUrl: '',
  conversionType: 'FREE_SIGNUP',
  rewardYen: '',
  facts: '',
  userExperience: '',
};

/** 1行に1つ。空行は落とす */
function toFactItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function toInput(form: FormState): CreateOfferInput {
  const reward = Number.parseInt(form.rewardYen, 10);
  const items = toFactItems(form.facts);

  return {
    name: form.name.trim(),
    aspName: form.aspName.trim(),
    landingPageUrl: form.landingPageUrl.trim(),
    affiliateUrl: form.affiliateUrl.trim(),
    conversionType: form.conversionType,
    ...(Number.isInteger(reward) && reward >= 0 ? { rewardYen: reward } : {}),
    // **空なら送らない。** 送ると `facts_updated_at` が入り、
    // 「確かめた」ことになってしまう（D-13・Q-022）
    ...(items.length === 0 ? {} : { facts: { items } }),
    ...(form.userExperience === ''
      ? {}
      : { userExperience: form.userExperience }),
  };
}

export default function OffersPage({
  params,
}: {
  params: Promise<{ blogId: string }>;
}) {
  const { blogId } = use(params);
  const nameId = useId();
  const aspId = useId();
  const lpId = useId();
  const linkId = useId();
  const conversionId = useId();
  const rewardId = useId();
  const experienceId = useId();
  const factsId = useId();

  const [offers, setOffers] = useState<OfferJson[] | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchOffers(blogId).then(
      (result) => {
        if (!cancelled) setOffers(result.offers);
      },
      (thrown: unknown) => {
        if (cancelled) return;

        setOffers([]);
        setError(
          thrown instanceof OfferApiError
            ? thrown.message
            : '読み込めませんでした',
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [blogId]);

  if (offers === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const canSubmit =
    !submitting &&
    form.name.trim() !== '' &&
    form.aspName.trim() !== '' &&
    form.landingPageUrl.trim() !== '' &&
    form.affiliateUrl.trim() !== '' &&
    form.userExperience !== '';

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">案件を登録する</h1>
      <p className="mt-1 text-xs leading-relaxed">
        紹介する商品・サービスです。<strong>何件でも登録できます。</strong>
        1件登録すると入力欄が空に戻るので、続けて入れられます
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {error}
        </p>
      )}

      {offers.length === 0 ? null : (
        <section className="mt-4">
          <h2 className="text-sm font-bold">登録済み（{offers.length} 件）</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {offers.map((offer) => (
              <li key={offer.id} className="rounded-lg border p-3">
                <p className="text-sm font-bold">{offer.name}</p>
                <p className="mt-1 text-xs">
                  {offer.aspName}・{OFFER_STATUS_LABELS[offer.status]}
                  {offer.rewardYen === null
                    ? ''
                    : `・${offer.rewardYen.toLocaleString('ja-JP')} 円`}
                </p>
                {/*
                  **切れているリンクは黙って置かない**（H-3b）。
                  貼ったままだと成果にならない
                */}
                {/*
                  **事実が空なら言う。** 空のまま気づかないと、
                  記事に数字を書けないことが後で分かる（Q-050）
                */}
                <p className="mt-1 text-xs">
                  {readFactItems(offer.facts).length === 0
                    ? '事実が未記入です'
                    : `事実 ${readFactItems(offer.facts).length} 件`}
                </p>
                {offer.linkBrokenAt === null ? null : (
                  <p className="mt-1 text-xs">リンクが切れています</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;

          setSubmitting(true);
          setError(null);

          void createOffer(blogId, toInput(form)).then(
            (result) => {
              setSubmitting(false);
              setOffers([...offers, result.offer]);
              // **続けて登録できるようにする。** 1件ごとに画面を
              // 開き直させない
              setForm(EMPTY_FORM);
              setDrafted(false);
            },
            (thrown: unknown) => {
              setSubmitting(false);
              setError(
                thrown instanceof OfferApiError
                  ? thrown.message
                  : '保存できませんでした',
              );
            },
          );
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-bold">
            案件の名前
          </label>
          <input
            id={nameId}
            className="rounded border p-2 text-base"
            value={form.name}
            maxLength={200}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={aspId} className="text-sm font-bold">
            ASP の名前
          </label>
          <input
            id={aspId}
            className="rounded border p-2 text-base"
            value={form.aspName}
            maxLength={100}
            onChange={(event) => {
              setForm({ ...form, aspName: event.target.value });
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={lpId} className="text-sm font-bold">
            紹介先のページ
          </label>
          <input
            id={lpId}
            className="rounded border p-2 text-base"
            value={form.landingPageUrl}
            maxLength={2000}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              setForm({ ...form, landingPageUrl: event.target.value });
            }}
          />
          <p className="text-xs leading-relaxed">
            読者が最後に見るページです（広告主のサイト）
          </p>

          {/*
           **AIは案を出す係**（Q-053）。読み取った値は下書きで、
           **人が確かめてから登録される。** ここでは保存しない
           */}
          <button
            type="button"
            disabled={drafting || form.landingPageUrl.trim() === ''}
            className="mt-1 rounded-lg border p-3 text-sm disabled:opacity-50"
            onClick={() => {
              setDrafting(true);
              setError(null);

              void draftOffer(blogId, form.landingPageUrl.trim()).then(
                ({ draft }) => {
                  setDrafting(false);
                  setDrafted(true);
                  setForm((current) => ({
                    ...current,
                    name: draft.name,
                    conversionType: draft.conversionType,
                    facts: draft.facts.join('\n'),
                  }));
                },
                (thrown: unknown) => {
                  setDrafting(false);
                  setError(
                    thrown instanceof OfferApiError
                      ? thrown.message
                      : '読み取れませんでした。手で入力してください',
                  );
                },
              );
            }}
          >
            {drafting ? '読み取っています' : 'このページから読み取る'}
          </button>
          <p className="text-xs leading-relaxed">
            案件の名前・成果の条件・事実を下書きします。
            <strong>ASP の名前とリンクは読み取れません</strong>（LPに無いため）
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={linkId} className="text-sm font-bold">
            アフィリエイトリンク
          </label>
          <input
            id={linkId}
            className="rounded border p-2 text-base"
            value={form.affiliateUrl}
            maxLength={2000}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              setForm({ ...form, affiliateUrl: event.target.value });
            }}
          />
          <p className="text-xs leading-relaxed">
            ASP が発行したURLを、そのまま貼り付けてください
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={conversionId} className="text-sm font-bold">
            成果になる条件
          </label>
          <select
            id={conversionId}
            className="rounded border p-2 text-base"
            value={form.conversionType}
            onChange={(event) => {
              setForm({
                ...form,
                conversionType: event.target.value as ConversionType,
              });
            }}
          >
            {CONVERSION_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {CONVERSION_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {/*
          **既定を `UNKNOWN` にしない。** 記事の書き方が変わる（SPEC 9.6）。
          既定で流すと、使っていない案件に「使ってみました」と書きうる
        */}
        <div className="flex flex-col gap-1">
          <label htmlFor={experienceId} className="text-sm font-bold">
            自分で使ったことがあるか
          </label>
          <select
            id={experienceId}
            className="rounded border p-2 text-base"
            value={form.userExperience}
            onChange={(event) => {
              setForm({
                ...form,
                userExperience: event.target.value as UserExperience | '',
              });
            }}
          >
            <option value="">選んでください</option>
            {USER_EXPERIENCE_VALUES.map((value) => (
              <option key={value} value={value}>
                {USER_EXPERIENCE_LABELS[value]}
              </option>
            ))}
          </select>
          <p className="text-xs leading-relaxed">
            記事の書き方が変わります。使っていないものを「使ってみました」
            とは書きません
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={rewardId} className="text-sm font-bold">
            報酬額（円）
          </label>
          <input
            id={rewardId}
            className="rounded border p-2 text-base"
            value={form.rewardYen}
            inputMode="numeric"
            onChange={(event) => {
              setForm({
                ...form,
                rewardYen: event.target.value.replace(/[^0-9]/g, ''),
              });
            }}
          />
          <p className="text-xs leading-relaxed">分からなければ空のままで</p>
        </div>

        {/*
          **形は決めるが、中身は決めない**（Q-050）。読む側は
          葉の値だけを見るので、1行に1つで足りる
        */}
        <div className="flex flex-col gap-1">
          <label htmlFor={factsId} className="text-sm font-bold">
            事実（1行に1つ）
          </label>
          <textarea
            id={factsId}
            className="rounded border p-2 text-base"
            rows={4}
            value={form.facts}
            placeholder={'月額1,480円\n初期費用なし\n違約金なし'}
            onChange={(event) => {
              setForm({ ...form, facts: event.target.value });
            }}
          />
          <p className="text-xs leading-relaxed">
            価格・条件・機能をそのまま書いてください。
            <strong>ここに無い数字は記事に書きません。</strong>
            空のままだと、書ける内容がとても狭くなります
          </p>
          {/*
            **下書きのまま通させない**（D-13・Q-022）。登録すると
            「確かめた」ことになる。**確かめるのは人**
          */}
          {drafted ? (
            <p className="text-xs leading-relaxed">
              <strong>ページから読み取った下書きです。</strong>
              合っているか必ず確かめてください。登録すると
              「確かめた事実」として記録されます
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
        >
          {submitting ? '保存しています' : '登録する'}
        </button>
      </form>

      <Link
        href="/liff/onboarding"
        className="mt-6 block text-center text-xs underline"
      >
        はじめの設定へ戻る
      </Link>
    </main>
  );
}
