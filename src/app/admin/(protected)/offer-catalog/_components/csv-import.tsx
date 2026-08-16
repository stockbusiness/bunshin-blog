'use client';

import { useState } from 'react';
import {
  BUTTON,
  BUTTON_PRIMARY,
  Badge,
  Card,
  HINT,
  INPUT,
  LABEL,
  TD,
  TH,
  TableFrame,
} from '../../_components/ui';
import {
  CatalogApiError,
  previewImport,
  registerImported,
  type ImportPreviewJson,
} from '../_lib/catalog-api';

/**
 * ASPのCSVを取り込む画面（Q-056）。
 *
 * ## なぜCSVなのか
 *
 * **AIがASPから直接集めることはできない。** 管理画面はログインが要り、
 * 自動巡回は規約違反になりうる（**成果を無効にされると取り返しがつかない**）。
 *
 * ## 「膨大」は足切りで解く
 *
 * SPEC 9.2.3 の足切りで**数千件が数十件になる。**
 * **何件がどの理由で落ちたかを必ず出す** — 黙って捨てると、
 * 「入れたはずの案件が無い」が起きる。
 *
 * ## AIがやるのは列の対応づけだけ
 *
 * ASPごとに見出しが違う。**AIが返すのは列の番号だけで、値は返さない。**
 * **間違っても、この画面で直せる。**
 */

/** 落ちた理由の日本語（SPEC 9.2.3） */
const REASON_LABELS: Record<string, string> = {
  ended: '掲載終了・提携終了',
  paused: '一時停止中',
  low_reward_purchase: '購入型で報酬3,000円未満',
  low_reward_free_signup: '無料登録型で報酬800円未満',
  many_deny_conditions: '否認条件が3つ以上',
  lp_not_mobile_ready: 'LPがスマホ非対応',
  blog_posting_prohibited: 'ブログ掲載禁止',
};

const FIELD_LABELS: { key: string; label: string }[] = [
  { key: 'name', label: '案件の名前' },
  { key: 'advertiserName', label: '広告主' },
  { key: 'landingPageUrl', label: '紹介先のページ' },
  { key: 'rewardYen', label: '報酬額' },
  { key: 'conversionType', label: '成果になる条件' },
  { key: 'denyConditions', label: '否認条件' },
  { key: 'status', label: '提携の状態' },
];

function messageOf(thrown: unknown): string {
  return thrown instanceof CatalogApiError
    ? thrown.message
    : 'うまくいきませんでした';
}

/** ブラウザで読んだバイト列を base64 にする（`multipart` を使わない） */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  // **一度に渡さない。** 大きいCSVで引数の上限に当たる
  for (let at = 0; at < bytes.length; at += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8_192));
  }

  return btoa(binary);
}

export function CsvImport({ onRegistered }: { onRegistered: () => void }) {
  const [csvBase64, setCsvBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [aspName, setAspName] = useState('');
  const [preview, setPreview] = useState<ImportPreviewJson | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function run(action: () => Promise<void>): void {
    setBusy(true);
    setError(null);
    setNotice(null);

    void action()
      .catch((thrown: unknown) => {
        setError(messageOf(thrown));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function load(base64: string, mapping?: Record<string, number>): void {
    run(async () => {
      const loaded = await previewImport(base64, mapping);

      setPreview(loaded);
      // **既定で全部選ぶ。** 足切りを通ったものを、外すほうを選ばせる
      setChosen(new Set(loaded.kept.map((item) => item.rowNumber)));
    });
  }

  return (
    <Card
      title="ASPのCSVから取り込む"
      description={
        <>
          ASPの管理画面から「提携プログラム一覧」を書き出して上げてください。
          <strong>報酬額や成果条件で自動的に絞り込みます</strong>
          （SPEC 9.2.3）。
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className={LABEL}>
          ASPの名前
          <input
            className={INPUT}
            value={aspName}
            placeholder="A8.net"
            onChange={(event) => {
              setAspName(event.target.value);
            }}
          />
        </label>

        <label className={LABEL}>
          CSVファイル
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file === undefined) {
                return;
              }

              setFileName(file.name);

              run(async () => {
                const base64 = toBase64(await file.arrayBuffer());

                setCsvBase64(base64);
                load(base64);
              });
            }}
          />
        </label>
        <p className={HINT}>
          Shift_JIS のままで読めます。
          <strong>列の対応はAIが推測し、下で直せます</strong>
        </p>

        {error === null ? null : (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        )}
        {notice === null ? null : (
          <p
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            {notice}
          </p>
        )}

        {preview === null ? null : (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-bold text-slate-900">
                読み込みました（{fileName}）
              </h3>
              <p className="text-sm text-slate-700">
                {preview.totalRows} 行のうち、
                <strong>{preview.kept.length} 件が残りました</strong>
                {preview.droppedRows === 0
                  ? ''
                  : `（${String(preview.droppedRows)} 行は上限を超えたため読んでいません）`}
              </p>

              {Object.keys(preview.droppedByReason).length === 0 ? null : (
                <ul className="flex flex-wrap gap-2">
                  {Object.entries(preview.droppedByReason).map(
                    ([reason, count]) => (
                      <li key={reason}>
                        <Badge tone="neutral">
                          {REASON_LABELS[reason] ?? reason}：{count} 件
                        </Badge>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </section>

            {/*
              **AIの推測を直せるようにする。** 列がずれたまま取り込むと、
              報酬額の欄に案件名が入る
            */}
            <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">
                列の対応を直す
              </summary>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {FIELD_LABELS.map((field) => (
                  <label key={field.key} className={`${LABEL} text-xs`}>
                    {field.label}
                    <select
                      className={INPUT}
                      value={preview.mapping[field.key] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        const next = { ...preview.mapping };

                        if (value === '') {
                          delete next[field.key];
                        } else {
                          next[field.key] = Number.parseInt(value, 10);
                        }

                        setPreview({ ...preview, mapping: next });
                      }}
                    >
                      <option value="">使わない</option>
                      {preview.headers.map((header, at) => (
                        <option key={`${header}-${String(at)}`} value={at}>
                          {at}: {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <button
                type="button"
                disabled={busy || csvBase64 === null}
                className={`mt-3 ${BUTTON}`}
                onClick={() => {
                  if (csvBase64 !== null) {
                    load(csvBase64, preview.mapping);
                  }
                }}
              >
                この対応で読み直す
              </button>
            </details>

            {preview.kept.length === 0 ? (
              <p className="text-sm text-slate-700">
                残った案件がありません。
                <strong>列の対応が合っているか確かめてください</strong>
              </p>
            ) : (
              <>
                <TableFrame minWidth="44rem">
                  <thead>
                    <tr>
                      <th className={TH}>入れる</th>
                      <th className={TH}>案件</th>
                      <th className={TH}>報酬</th>
                      <th className={TH}>成果</th>
                      <th className={TH}>紹介先</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.kept.map((item) => (
                      <tr key={item.rowNumber}>
                        <td className={TD}>
                          <input
                            type="checkbox"
                            aria-label={`${item.name} を入れる`}
                            checked={chosen.has(item.rowNumber)}
                            onChange={(event) => {
                              const next = new Set(chosen);

                              if (event.target.checked) {
                                next.add(item.rowNumber);
                              } else {
                                next.delete(item.rowNumber);
                              }

                              setChosen(next);
                            }}
                          />
                        </td>
                        <td className={`${TD} font-medium text-slate-900`}>
                          {item.name}
                        </td>
                        <td className={`${TD} whitespace-nowrap text-right`}>
                          {item.rewardYen === null
                            ? '—'
                            : `${item.rewardYen.toLocaleString()}円`}
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {item.conversionType}
                        </td>
                        <td className={`${TD} max-w-xs truncate text-xs`}>
                          {item.landingPageUrl}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableFrame>

                <p className={HINT}>
                  <strong>取り込んだものは「下書き」で入ります。</strong>
                  事実（価格・条件）はCSVに無いので、
                  1件ずつ「このページから読み取る」で入れてから
                  「選べる」にしてください
                </p>

                <button
                  type="button"
                  disabled={busy || aspName.trim() === '' || chosen.size === 0}
                  className={`self-start ${BUTTON_PRIMARY}`}
                  onClick={() => {
                    run(async () => {
                      const items = preview.kept
                        .filter((item) => chosen.has(item.rowNumber))
                        .map((item) => ({
                          name: item.name,
                          advertiserName: item.advertiserName,
                          landingPageUrl: item.landingPageUrl,
                          rewardYen: item.rewardYen,
                          conversionType: item.conversionType,
                          denyConditions: item.denyConditions,
                        }));

                      const result = await registerImported(
                        aspName.trim(),
                        items,
                      );

                      setNotice(
                        `${String(result.added)} 件を下書きとして登録しました${
                          result.skipped === 0
                            ? ''
                            : `（${String(result.skipped)} 件はすでに登録済みでした）`
                        }`,
                      );
                      setPreview(null);
                      setChosen(new Set());
                      onRegistered();
                    });
                  }}
                >
                  選んだ {chosen.size} 件を下書きとして登録する
                </button>

                {aspName.trim() === '' ? (
                  <p className={HINT}>ASPの名前を入れてください</p>
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
