'use client';

import { useEffect, useState } from 'react';
import { approvalStatusLabel } from '../../_lib/approval-tabs';
import {
  ApprovalApiError,
  REVISION_CHOICES,
  approveApproval,
  fetchApprovalDetail,
  markApprovalViewed,
  requestRevision,
  skipApproval,
  type ApprovalDetailJson,
  type RevisionChoice,
} from '../../_lib/approvals-api';

/**
 * 承認詳細の中身（TASKS F-5、SPEC 6.1）。
 *
 * **`params` を受け取らない。** ページ側（Server Component）が解決した
 * `approvalId` を文字列で渡す。Promise をクライアントで開くと、
 * 描画がサスペンドの扱いに左右されて試験しにくい。
 *
 * 完了条件は「**未確認事実とリスク警告が表示される**」。
 *
 * ## 記事本文をこのページのDOMへ入れない
 *
 * 本文はAIが書いた HTML で、E-13 の検査は**表現**を見るもので
 * スクリプトを落とすものではない。`dangerouslySetInnerHTML` で入れると、
 * `<img onerror=...>` ひとつでこのページのセッションを触られる。
 *
 * **`sandbox` を空にした `iframe` に入れる。** スクリプトも遷移も
 * ブラウザが止めるため、中身が何であっても実行されない。
 * 確かめるべきアフィリエイトURLは SPEC 6.1 が別項目として並べており、
 * **本文中のリンクを踏ませる必要は無い**。
 *
 * ## 操作（F-6）
 *
 * SPEC 6.1 の「承認・修正依頼・見送り・後で確認」。
 * **「後で確認」はボタンを置かない** — 何もせず閉じることがそれで、
 * 開いた記録は `POST /view` が既に付けている。
 *
 * **答えたあとはボタンを消す。** 押せるままにすると、承認したものを
 * 見送ろうとして 409 を見ることになる（サーバー側は F-6 が弾く）。
 */

const PREVIEW_MIN_HEIGHT = 480;

function ArticlePreview({ bodyHtml }: { bodyHtml: string }) {
  return (
    <iframe
      // **空の `sandbox`。** スクリプト・遷移・同一オリジンのすべてを止める
      sandbox=""
      srcDoc={bodyHtml}
      title="記事本文"
      className="mt-2 w-full rounded border"
      style={{ minHeight: PREVIEW_MIN_HEIGHT }}
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function ApprovalDetail({ approvalId }: { approvalId: string }) {
  const [detail, setDetail] = useState<ApprovalDetailJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revisionType, setRevisionType] = useState<RevisionChoice | null>(null);
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchApprovalDetail(approvalId).then(
      (result) => {
        if (cancelled) return;

        setDetail(result);
        setStatus(result.approval.status);
        // **開いた記録は明示的に送る**（SPEC 13.6）。失敗しても画面は出す
        void markApprovalViewed(approvalId).then(
          (viewed) => {
            if (!cancelled) setStatus(viewed.status);
          },
          () => undefined,
        );
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
            thrown instanceof ApprovalApiError
              ? thrown.message
              : '読み込めませんでした',
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  if (error !== null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  if (detail === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const { approval, article, generation, offer, banners } = detail;
  const warnings = article.riskFlags;
  const current = status ?? approval.status;
  const answered = current !== 'PENDING' && current !== 'VIEWED';

  async function run(action: () => Promise<{ status: string }>) {
    setBusy(true);
    setActionError(null);

    try {
      const result = await action();
      setStatus(result.status);
    } catch (thrown) {
      setActionError(
        thrown instanceof ApprovalApiError
          ? thrown.message
          : '送信できませんでした',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh p-4">
      <p className="text-xs">{approval.blogName}</p>
      <h1 className="mt-1 text-lg font-bold">{article.title}</h1>
      <p className="mt-1 text-xs">
        {approvalStatusLabel(approval.status)}・第{article.versionNo}版
      </p>

      <Section title="提案理由">
        <p className="mt-1 text-sm leading-relaxed">
          {approval.proposalReason}
        </p>
      </Section>

      {/* **完了条件。** 開いた人が最初に見るべきもの */}
      <Section title="未確認の事実">
        {article.unverifiedClaims.length === 0 ? (
          <p className="mt-1 text-sm">ありません。</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {article.unverifiedClaims.map((claim, index) => (
              <li
                key={`${claim.text ?? ''}-${index}`}
                className="rounded border p-3 text-sm leading-relaxed"
              >
                <p>{claim.text ?? ''}</p>
                <p className="mt-1 text-xs">
                  {claim.type ?? ''}
                  {claim.reason === undefined ? '' : `・${claim.reason}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* **完了条件** */}
      <Section title="リスク警告">
        {warnings.length === 0 ? (
          <p className="mt-1 text-sm">ありません。</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {warnings.map((flag, index) => (
              <li
                key={`${flag.code ?? ''}-${index}`}
                className="rounded border p-3 text-sm leading-relaxed"
              >
                <p>{flag.message ?? ''}</p>
                {flag.excerpt === undefined || flag.excerpt === '' ? null : (
                  <p className="mt-1 text-xs">該当箇所：{flag.excerpt}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="結論">
        <p className="mt-1 text-sm leading-relaxed">{article.answerCapsule}</p>
      </Section>

      <Section title="記事全文">
        <ArticlePreview bodyHtml={article.bodyHtml} />
      </Section>

      {article.faq.length === 0 ? null : (
        <Section title="よくある質問">
          <dl className="mt-1 flex flex-col gap-2 text-sm leading-relaxed">
            {article.faq.map((entry) => (
              <div key={entry.question}>
                <dt className="font-bold">{entry.question}</dt>
                <dd>{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="重要な変更点">
        <p className="mt-1 text-sm leading-relaxed">
          {/* Phase 0 で作るのは新規記事の提案だけ（F-1） */}
          {approval.proposalType === 'NEW_ARTICLE'
            ? '新しい記事のため、変更点はありません。'
            : '—'}
        </p>
      </Section>

      <Section title="使用する案件">
        {offer === null ? (
          <p className="mt-1 text-sm">案件は使いません。</p>
        ) : (
          <div className="mt-1 text-sm leading-relaxed">
            <p>{offer.name}</p>
            {/* **URLは文字として見せる。** 承認の場で踏ませない */}
            <p className="mt-1 break-all text-xs">{offer.affiliateUrl}</p>
          </div>
        )}
      </Section>

      {banners.length === 0 ? null : (
        <Section title="バナー">
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {banners.map((banner) => (
              <li key={banner.id}>
                {banner.name}（{banner.slot}）
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="AI生成情報">
        <p className="mt-1 text-xs leading-relaxed">
          {generation.modelProvider} / {generation.modelName}
          <br />
          プロンプト {generation.promptVersion}
          <br />
          入力 {generation.inputTokens} / 出力 {generation.outputTokens}{' '}
          トークン
          <br />
          概算費用 {generation.estimatedCostUsd} USD
        </p>
      </Section>

      <Section title="この提案をどうしますか">
        {answered ? (
          /* **答えたあとはボタンを消す。** 押せるままだと 409 を見ることになる */
          <p className="mt-1 text-sm">
            回答済みです（{approvalStatusLabel(current)}）。
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => approveApproval(approvalId))}
                className="rounded border px-4 py-2 text-sm font-bold"
              >
                承認する
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => skipApproval(approvalId))}
                className="rounded border px-4 py-2 text-sm"
              >
                今回は見送る
              </button>
            </div>

            <fieldset className="rounded border p-3">
              <legend className="px-1 text-xs">修正を依頼する</legend>
              <div className="flex flex-col gap-1">
                {REVISION_CHOICES.map((choice) => (
                  <label key={choice.value} className="text-sm">
                    <input
                      type="radio"
                      name="revisionType"
                      value={choice.value}
                      checked={revisionType === choice.value}
                      onChange={() => setRevisionType(choice.value)}
                      className="mr-2"
                    />
                    {choice.label}
                  </label>
                ))}
              </div>

              <label className="mt-2 block text-xs">
                補足（その他を選んだときは必須）
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border p-2 text-sm"
                />
              </label>

              <button
                type="button"
                /* **その他は本文が要る。** 何を直すか分からない依頼を残さない */
                disabled={
                  busy ||
                  revisionType === null ||
                  (revisionType === 'FREE_TEXT' && comment.trim() === '')
                }
                onClick={() =>
                  void run(() =>
                    requestRevision(approvalId, {
                      requestType: revisionType as RevisionChoice,
                      ...(comment.trim() === ''
                        ? {}
                        : { comment: comment.trim() }),
                    }),
                  )
                }
                className="mt-2 rounded border px-4 py-2 text-sm"
              >
                修正を依頼する
              </button>
            </fieldset>

            {/*
              **「後で確認」のボタンは置かない。** 何もせず閉じることが
              それで、開いた記録は `POST /view` が付けている
            */}
          </div>
        )}

        {actionError === null ? null : (
          <p className="mt-2 text-sm leading-relaxed">{actionError}</p>
        )}
      </Section>
    </main>
  );
}
