'use client';

import { useEffect, useState } from 'react';
import {
  BUTTON,
  BUTTON_PRIMARY,
  Badge,
  Card,
  EmptyState,
  HINT,
  INPUT,
  LABEL,
  TD,
  TH,
  TableFrame,
  type BadgeTone,
} from '../../_components/ui';
import {
  CatalogApiError,
  createCatalogItem,
  draftCatalogItem,
  fetchCatalog,
  updateCatalogItem,
  type CatalogItemInputJson,
  type CatalogItemJson,
  type CatalogStatus,
  type ConversionType,
  type LinkMode,
} from '../_lib/catalog-api';

/**
 * 案件カタログを作る画面（Q-055、段8）。
 *
 * ## ここで入れたものが30ブログに広がる
 *
 * `facts` は**記事に書ける数値の出どころ**（SPEC 9.6）。
 * ここが間違うと、**全モニターの記事に同じ間違いが載る。**
 * だから LP から読み取ったあとも、**人が確かめてから `ACTIVE` にする。**
 *
 * ## `ACTIVE` にするまでモニターには出ない
 *
 * `DRAFT` は調べている途中。**中途半端なものを選ばせない。**
 */

const CONVERSION_LABELS: Record<ConversionType, string> = {
  FREE_SIGNUP: '無料登録',
  REQUEST: '資料請求',
  TRIAL: '無料体験',
  PURCHASE: '購入',
  OTHER: 'そのほか',
};

const STATUS_LABELS: Record<CatalogStatus, string> = {
  DRAFT: '下書き',
  ACTIVE: '選べる',
  PAUSED: '休み',
  ENDED: '終了',
};

const STATUS_TONES: Record<CatalogStatus, BadgeTone> = {
  DRAFT: 'warn',
  ACTIVE: 'ok',
  PAUSED: 'neutral',
  ENDED: 'neutral',
};

interface FormState {
  name: string;
  aspName: string;
  advertiserName: string;
  landingPageUrl: string;
  rewardYen: string;
  conversionType: ConversionType;
  facts: string;
  denyConditions: string;
  linkMode: LinkMode;
  subIdParam: string;
  blogPostingProhibited: boolean;
  genreHints: string;
  notes: string;
  status: CatalogStatus;
}

const EMPTY_FORM: FormState = {
  name: '',
  aspName: '',
  advertiserName: '',
  landingPageUrl: '',
  rewardYen: '',
  conversionType: 'FREE_SIGNUP',
  facts: '',
  denyConditions: '',
  linkMode: 'DIRECT',
  subIdParam: '',
  blogPostingProhibited: false,
  genreHints: '',
  notes: '',
  status: 'DRAFT',
};

function toForm(item: CatalogItemJson): FormState {
  return {
    name: item.name,
    aspName: item.aspName,
    advertiserName: item.advertiserName ?? '',
    landingPageUrl: item.landingPageUrl,
    rewardYen: item.rewardYen === null ? '' : String(item.rewardYen),
    conversionType: item.conversionType,
    facts: item.facts.join('\n'),
    denyConditions: item.denyConditions.join('\n'),
    linkMode: item.linkMode,
    subIdParam: item.subIdParam ?? '',
    blogPostingProhibited: item.blogPostingProhibited,
    genreHints: item.genreHints.join('\n'),
    notes: item.notes ?? '',
    status: item.status,
  };
}

/** 1行に1つ（Q-050）。空行は落とす */
export function readLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function toInput(form: FormState): CatalogItemInputJson {
  const reward = Number.parseInt(form.rewardYen, 10);

  return {
    name: form.name.trim(),
    aspName: form.aspName.trim(),
    advertiserName:
      form.advertiserName.trim() === '' ? null : form.advertiserName.trim(),
    landingPageUrl: form.landingPageUrl.trim(),
    rewardYen: Number.isNaN(reward) ? null : reward,
    conversionType: form.conversionType,
    facts: readLines(form.facts),
    denyConditions: readLines(form.denyConditions),
    linkMode: form.linkMode,
    subIdParam: form.subIdParam.trim() === '' ? null : form.subIdParam.trim(),
    blogPostingProhibited: form.blogPostingProhibited,
    genreHints: readLines(form.genreHints),
    notes: form.notes.trim() === '' ? null : form.notes.trim(),
    status: form.status,
  };
}

function messageOf(thrown: unknown): string {
  return thrown instanceof CatalogApiError
    ? thrown.message
    : 'うまくいきませんでした';
}

export function CatalogEditor() {
  const [items, setItems] = useState<CatalogItemJson[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchCatalog().then(
      (loaded) => {
        if (!cancelled) {
          setItems(loaded.items);
        }
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setItems([]);
          setError(messageOf(thrown));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  function update(changes: Partial<FormState>): void {
    setForm((current) => ({ ...current, ...changes }));
  }

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

  return (
    <div className="flex flex-col gap-6">
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

      <Card
        title={editingId === null ? '案件を足す' : '案件を直す'}
        description={
          <>
            <strong>ここで入れた事実が、全モニターの記事に載ります。</strong>
            読み取ったあとも必ず確かめてください
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className={LABEL}>
              紹介先のページ
              <input
                className={INPUT}
                value={form.landingPageUrl}
                onChange={(event) => {
                  update({ landingPageUrl: event.target.value });
                }}
              />
            </label>

            {/* Q-053 の読み取りをそのまま使う。**正しさを2か所に持たない** */}
            <button
              type="button"
              disabled={busy || form.landingPageUrl.trim() === ''}
              className={`self-start ${BUTTON}`}
              onClick={() => {
                run(async () => {
                  const { draft } = await draftCatalogItem(
                    form.landingPageUrl.trim(),
                  );

                  update({
                    name: draft.name,
                    conversionType: draft.conversionType,
                    facts: draft.facts.join('\n'),
                  });
                  setDrafted(true);
                  setNotice('読み取りました。必ず確かめてください');
                });
              }}
            >
              このページから読み取る
            </button>
            <p className={HINT}>
              名前・成果の条件・事実を下書きします。
              <strong>ASPの名前と報酬額は読み取れません</strong>（LPに無いため）
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              案件の名前
              <input
                className={INPUT}
                value={form.name}
                onChange={(event) => {
                  update({ name: event.target.value });
                }}
              />
            </label>

            <label className={LABEL}>
              ASPの名前
              <input
                className={INPUT}
                value={form.aspName}
                onChange={(event) => {
                  update({ aspName: event.target.value });
                }}
              />
            </label>

            <label className={LABEL}>
              広告主（任意）
              <input
                className={INPUT}
                value={form.advertiserName}
                onChange={(event) => {
                  update({ advertiserName: event.target.value });
                }}
              />
            </label>

            <label className={LABEL}>
              報酬額（円）
              <input
                type="number"
                className={INPUT}
                value={form.rewardYen}
                onChange={(event) => {
                  update({ rewardYen: event.target.value });
                }}
              />
            </label>

            <label className={LABEL}>
              成果になる条件
              <select
                className={INPUT}
                value={form.conversionType}
                onChange={(event) => {
                  update({
                    conversionType: event.target.value as ConversionType,
                  });
                }}
              >
                {Object.entries(CONVERSION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className={LABEL}>
              状態
              <select
                className={INPUT}
                value={form.status}
                onChange={(event) => {
                  update({ status: event.target.value as CatalogStatus });
                }}
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <label className={LABEL}>
              事実（1行に1つ）
              <textarea
                className={`${INPUT} min-h-28`}
                value={form.facts}
                onChange={(event) => {
                  update({ facts: event.target.value });
                }}
              />
            </label>
            <p className={HINT}>
              価格・条件・機能を1行に1つ。
              <strong>ここに無い数字は記事に書きません</strong>
            </p>
            {drafted ? (
              <p className={HINT}>
                <strong>ページから読み取った下書きです。</strong>
                合っているか必ず確かめてください
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label className={LABEL}>
              どんなブログに向くか（1行に1つ・任意）
              <textarea
                className={`${INPUT} min-h-20`}
                value={form.genreHints}
                onChange={(event) => {
                  update({ genreHints: event.target.value });
                }}
              />
            </label>
            <p className={HINT}>
              AIが候補を出すときに読みます。例：一人暮らし／通信費の節約
            </p>
          </div>

          {/*
            **ASPの規約の判断はここに集める**（Q-001・Q-014・Q-019）。
            モニターには触らせない
          */}
          <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              ASPの規約に関わる設定
            </summary>

            <div className="mt-3 flex flex-col gap-4">
              <label className={LABEL}>
                リンクの出し方
                <select
                  className={INPUT}
                  value={form.linkMode}
                  onChange={(event) => {
                    update({ linkMode: event.target.value as LinkMode });
                  }}
                >
                  <option value="DIRECT">そのまま貼る（安全側）</option>
                  <option value="REDIRECT">
                    /go/ を経由する（クリックを数えられる）
                  </option>
                </select>
              </label>
              <p className={HINT}>
                <strong>規約を確かめたものだけ /go/ にしてください。</strong>
                誤ると成果が無効になります（Q-001）
              </p>

              <label className={LABEL}>
                サブIDのパラメータ名（任意）
                <input
                  className={INPUT}
                  value={form.subIdParam}
                  onChange={(event) => {
                    update({ subIdParam: event.target.value });
                  }}
                />
              </label>
              <p className={HINT}>ASPによって違います（sub / s1 / argument）</p>

              <label className={LABEL}>
                否認条件（1行に1つ）
                <textarea
                  className={`${INPUT} min-h-20`}
                  value={form.denyConditions}
                  onChange={(event) => {
                    update({ denyConditions: event.target.value });
                  }}
                />
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.blogPostingProhibited}
                  onChange={(event) => {
                    update({ blogPostingProhibited: event.target.checked });
                  }}
                />
                ブログへの掲載が禁じられている
              </label>
              <p className={HINT}>
                入れると<strong>モニターには出ません</strong>（SPEC 9.2.3）
              </p>
            </div>
          </details>

          <label className={LABEL}>
            運営のメモ（任意）
            <textarea
              className={`${INPUT} min-h-16`}
              value={form.notes}
              onChange={(event) => {
                update({ notes: event.target.value });
              }}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={BUTTON_PRIMARY}
              onClick={() => {
                run(async () => {
                  const input = toInput(form);
                  const saved =
                    editingId === null
                      ? await createCatalogItem(input)
                      : await updateCatalogItem(editingId, input);

                  setItems((current) =>
                    current === null
                      ? [saved.item]
                      : editingId === null
                        ? [saved.item, ...current]
                        : current.map((row) =>
                            row.id === editingId ? saved.item : row,
                          ),
                  );
                  setForm(EMPTY_FORM);
                  setEditingId(null);
                  setDrafted(false);
                  setNotice(editingId === null ? '登録しました' : '直しました');
                });
              }}
            >
              {editingId === null ? '登録する' : '直す'}
            </button>

            {editingId === null ? null : (
              <button
                type="button"
                disabled={busy}
                className={BUTTON}
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setEditingId(null);
                  setDrafted(false);
                  setNotice(null);
                  setError(null);
                }}
              >
                やめる
              </button>
            )}
          </div>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-slate-900">
          登録した案件{items === null ? '' : `（${String(items.length)} 件）`}
        </h2>

        {items === null ? (
          <p className="text-sm text-slate-500">読み込んでいます…</p>
        ) : items.length === 0 ? (
          <EmptyState>
            まだ1件もありません。
            <br />
            <strong>案件が無いと、モニターは段7の審査を通れません</strong>
            （案件0件は停止条件）。
          </EmptyState>
        ) : (
          <TableFrame minWidth="52rem">
            <thead>
              <tr>
                <th className={TH}>案件</th>
                <th className={TH}>ASP</th>
                <th className={TH}>成果</th>
                <th className={TH}>報酬</th>
                <th className={TH}>事実</th>
                <th className={TH}>状態</th>
                <th className={TH}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className={`${TD} font-medium text-slate-900`}>
                    {item.name}
                  </td>
                  <td className={TD}>{item.aspName}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {CONVERSION_LABELS[item.conversionType]}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {item.rewardYen === null
                      ? '—'
                      : `${item.rewardYen.toLocaleString()}円`}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {item.facts.length === 0 ? (
                      <Badge tone="warn">なし</Badge>
                    ) : (
                      `${String(item.facts.length)} 件`
                    )}
                  </td>
                  <td className={TD}>
                    <Badge tone={STATUS_TONES[item.status]}>
                      {STATUS_LABELS[item.status]}
                    </Badge>
                  </td>
                  <td className={TD}>
                    <button
                      type="button"
                      className={`${BUTTON} px-2 py-1 text-xs`}
                      onClick={() => {
                        setEditingId(item.id);
                        setForm(toForm(item));
                        setDrafted(false);
                        setNotice(null);
                        setError(null);
                      }}
                    >
                      直す
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
      </section>
    </div>
  );
}
