'use client';

import { useState } from 'react';
import {
  OfferApiError,
  updateOfferPartnership,
  type OfferJson,
  type PartnershipStatus,
} from '../../../../_lib/offers-api';

/**
 * 提携の状態を出して、変えられるようにする（Q-060、構想書13章）。
 *
 * ## なぜ画面に出すのか
 *
 * **提携が承認されていない案件は記事にならない**（記事候補から外れる）。
 * 出さないと、モニターは**「登録したのに記事が来ない」**としか分からない。
 *
 * ## 打つのはリンクだけ
 *
 * **リンクは提携が承認されないと発行できない。** つまり
 * **リンクを入れられた＝承認された**なので、状態を選ばせる必要はない
 * （Q-058「打たせない」）。
 *
 * 例外は**断られたとき。** リンクが発行されないので、こちらからは
 * 「まだ待っている」のか「断られた」のか分からない。**本人にしか答えられない。**
 */

const LABELS: Record<PartnershipStatus, string> = {
  NOT_APPLIED: 'まだ申請していません',
  APPLIED: '申請して、返事を待っています',
  APPROVED: '提携できています',
  REJECTED: '提携できませんでした',
};

function messageOf(thrown: unknown): string {
  return thrown instanceof OfferApiError ? thrown.message : '保存できません';
}

export function PartnershipPanel({
  blogId,
  offer,
  onChanged,
}: {
  blogId: string;
  offer: OfferJson;
  onChanged: (offer: OfferJson) => void;
}) {
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function run(input: {
    affiliateUrl?: string;
    partnershipStatus?: PartnershipStatus;
  }): void {
    setBusy(true);
    setError(null);

    void updateOfferPartnership(blogId, offer.id, input).then(
      (result) => {
        setBusy(false);
        setLink('');
        onChanged(result.offer);
      },
      (thrown: unknown) => {
        setBusy(false);
        setError(messageOf(thrown));
      },
    );
  }

  // **提携できていれば、ここですることは無い**
  if (offer.partnershipStatus === 'APPROVED') {
    return <p className="mt-1 text-xs">{LABELS.APPROVED}</p>;
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border p-2">
      <p className="text-xs font-bold">{LABELS[offer.partnershipStatus]}</p>

      {/*
        **記事にならないことを先に言う。** 言わないと
        「登録したのに記事が来ない」としか分からない
      */}
      <p className="text-xs leading-relaxed">
        提携できるまで、この案件の記事はつくられません
      </p>

      {error === null ? null : (
        <p role="alert" className="text-xs leading-relaxed">
          {error}
        </p>
      )}

      {offer.partnershipStatus === 'REJECTED' ? null : (
        <label className="flex flex-col gap-1 text-xs">
          提携できたら、リンクを入れてください
          <input
            className="rounded-lg border p-2 text-base"
            aria-label={`${offer.name}のアフィリエイトリンク`}
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
            }}
          />
        </label>
      )}

      <div className="flex flex-col gap-2">
        {offer.partnershipStatus === 'REJECTED' ? null : (
          <button
            type="button"
            disabled={busy || link.trim() === ''}
            className="rounded-lg border p-3 text-sm font-bold disabled:opacity-50"
            onClick={() => {
              run({ affiliateUrl: link.trim() });
            }}
          >
            リンクを入れる
          </button>
        )}

        {offer.partnershipStatus === 'NOT_APPLIED' ? (
          <button
            type="button"
            disabled={busy}
            className="text-xs underline disabled:opacity-50"
            onClick={() => {
              run({ partnershipStatus: 'APPLIED' });
            }}
          >
            ASPに申請しました
          </button>
        ) : null}

        {/*
          **断られたことは本人にしか分からない。** リンクが来ないだけでは
          「待っている」と区別できない
        */}
        {offer.partnershipStatus === 'REJECTED' ? (
          <button
            type="button"
            disabled={busy}
            className="text-xs underline disabled:opacity-50"
            onClick={() => {
              run({ partnershipStatus: 'APPLIED' });
            }}
          >
            もう一度申請しました
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="text-xs underline disabled:opacity-50"
            onClick={() => {
              run({ partnershipStatus: 'REJECTED' });
            }}
          >
            提携を断られました
          </button>
        )}
      </div>
    </div>
  );
}
