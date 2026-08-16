'use client';

import { useEffect, useRef, useState } from 'react';
import {
  RichMenuApiError,
  applyRichMenu,
  fetchRichMenu,
  fetchRichMenuState,
  removeRemoteRichMenu,
  saveRichMenu,
  uploadRichMenuImage,
  type AreaJson,
  type CanvasName,
  type DestinationJson,
  type RichMenuJson,
  type RichMenuStateJson,
} from '../_lib/rich-menu-api';

/**
 * リッチメニューを組み立てる画面（Q-054、TASKS H-6）。
 *
 * ## 絵の上に升目を重ねる
 *
 * **座標を数字だけで決めさせない。** 4つの数を6組打つのは現実的でなく、
 * 打ち間違いは**「押しても何も起きないボタン」**として本番に出る。
 * 絵の上に押す場所を描いて、**見たまま確かめられる**ようにする。
 *
 * ## 型から入れて、要るところだけ直す
 *
 * **升目は型で入れる。** 数の入力は残すが、**ふだんは触らない。**
 *
 * ## 行き先は選ばせる
 *
 * **手で打たせない。** `LIFF_BASE_URL` から組み立てた候補を出す。
 */

const CANVAS = {
  LARGE: { width: 2500, height: 1686 },
  COMPACT: { width: 2500, height: 843 },
} as const;

/**
 * 升目の型。
 *
 * 行数×列数で表す。`LARGE` は2段まで、`COMPACT` は1段。
 */
const LAYOUTS = [
  { id: '2x3', label: '2段3列（6つ）', rows: 2, columns: 3, canvas: 'LARGE' },
  { id: '2x2', label: '2段2列（4つ）', rows: 2, columns: 2, canvas: 'LARGE' },
  { id: '1x3', label: '1段3列（3つ）', rows: 1, columns: 3, canvas: 'LARGE' },
  { id: '1x2', label: '1段2列（2つ）', rows: 1, columns: 2, canvas: 'LARGE' },
  {
    id: 'c1x3',
    label: '1段3列（3つ・細い枠）',
    rows: 1,
    columns: 3,
    canvas: 'COMPACT',
  },
  {
    id: 'c1x2',
    label: '1段2列（2つ・細い枠）',
    rows: 1,
    columns: 2,
    canvas: 'COMPACT',
  },
] as const satisfies readonly {
  id: string;
  label: string;
  rows: number;
  columns: number;
  canvas: CanvasName;
}[];

/**
 * 型から升目を作る。
 *
 * **端数を最後の升へ寄せる。** 割り切れないまま並べると**1pxの隙間**が
 * でき、そこだけ押しても反応しない。
 */
export function buildAreas(
  layout: { rows: number; columns: number },
  canvas: CanvasName,
  previous: readonly AreaJson[],
): AreaJson[] {
  const { width, height } = CANVAS[canvas];
  const cellWidth = Math.floor(width / layout.columns);
  const cellHeight = Math.floor(height / layout.rows);
  const areas: AreaJson[] = [];

  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const isLastColumn = column === layout.columns - 1;
      const isLastRow = row === layout.rows - 1;
      // **入れてあった名前と行き先は捨てない。** 型だけ変えたいことがある
      const kept = previous[areas.length];

      areas.push({
        x: cellWidth * column,
        y: cellHeight * row,
        width: isLastColumn ? width - cellWidth * column : cellWidth,
        height: isLastRow ? height - cellHeight * row : cellHeight,
        label: kept?.label ?? '',
        uri: kept?.uri ?? '',
      });
    }
  }

  return areas;
}

function joinLiffUrl(liffBaseUrl: string, path: string): string {
  return `${liffBaseUrl.replace(/\/+$/, '')}${path}`;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof RichMenuApiError
    ? thrown.message
    : 'うまくいきませんでした';
}

export function RichMenuEditor() {
  const [menu, setMenu] = useState<RichMenuJson | null>(null);
  const [liffBaseUrl, setLiffBaseUrl] = useState('');
  const [destinations, setDestinations] = useState<DestinationJson[]>([]);
  const [state, setState] = useState<RichMenuStateJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // **画像を読み直させる目印。** 差し替えてもURLは同じなので付ける
  const [imageVersion, setImageVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchRichMenu().then(
      (loaded) => {
        if (cancelled) {
          return;
        }

        setMenu(loaded.richMenu);
        setLiffBaseUrl(loaded.liffBaseUrl);
        setDestinations(loaded.destinations);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setLoadFailed(true);
          setError(messageOf(thrown));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  if (loadFailed) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error ?? '読み込めませんでした'}
      </p>
    );
  }

  if (menu === null) {
    return <p className="text-sm">読み込んでいます…</p>;
  }

  const canvas = CANVAS[menu.canvas];
  const ready = menu.hasImage && menu.areas.length > 0;

  function update(changes: Partial<RichMenuJson>): void {
    setMenu((current) =>
      current === null ? current : { ...current, ...changes },
    );
  }

  function updateArea(index: number, changes: Partial<AreaJson>): void {
    setMenu((current) =>
      current === null
        ? current
        : {
            ...current,
            areas: current.areas.map((area, at) =>
              at === index ? { ...area, ...changes } : area,
            ),
          },
    );
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
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}

      <section className="rounded-lg border p-3">
        <p className="text-sm">
          {menu.lineRichMenuId === null ? (
            <strong>まだLINEに出していません</strong>
          ) : (
            <>
              LINEに出ています（
              <code className="text-xs">{menu.lineRichMenuId}</code>）
            </>
          )}
        </p>

        {state === null ? null : (
          <p className="mt-1 text-sm">
            {state.applied ? (
              '確かめました。保存してあるものが全員に出ています'
            ) : (
              <strong>
                保存してあるものと、いま出ているものが違います。「LINEへ出す」を押してください
              </strong>
            )}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">1. 枠と文字</h2>

        <label className="flex flex-col gap-1 text-sm">
          管理用の名前
          <input
            className="rounded-lg border p-2"
            value={menu.name}
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          メニューバーの文字
          <input
            className="rounded-lg border p-2"
            maxLength={14}
            value={menu.chatBarText}
            onChange={(event) => {
              update({ chatBarText: event.target.value });
            }}
          />
        </label>
        <p className="text-xs leading-relaxed">
          トークの下に出る文字です（14字まで）。押すとメニューが開きます
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={menu.selected}
            onChange={(event) => {
              update({ selected: event.target.checked });
            }}
          />
          はじめから開いた状態で出す
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">2. 押す場所の型</h2>
        <p className="text-xs leading-relaxed">
          型を選ぶと升目が入ります。
          <strong>入れてある名前と行き先は消えません</strong>
        </p>

        <div className="flex flex-wrap gap-2">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className="rounded-lg border p-2 text-sm"
              onClick={() => {
                update({
                  canvas: layout.canvas,
                  areas: buildAreas(layout, layout.canvas, menu.areas),
                });
              }}
            >
              {layout.label}
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed">
          いまの枠は {canvas.width}×{canvas.height} です。
          <strong>画像も同じ縦横比にしてください</strong>
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">3. 画像</h2>
        <p className="text-xs leading-relaxed">
          PNG か JPEG、1MB以下。横は 800〜2500px。
          <strong>枠と縦横比が違うものは受け取りません</strong>
          （升目と、指で押す場所がずれるためです）
        </p>

        <label className="flex flex-col gap-1 text-sm">
          画像を選ぶ
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="text-sm"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file === undefined) {
                return;
              }

              run(async () => {
                const buffer = await file.arrayBuffer();
                const { richMenu } = await uploadRichMenuImage(
                  buffer,
                  file.type,
                );

                // **升目は今いじっている値を残す。** 画像だけ差し替える
                update({
                  hasImage: richMenu.hasImage,
                  imageWidth: richMenu.imageWidth,
                  imageHeight: richMenu.imageHeight,
                });
                setImageVersion((version) => version + 1);
                setNotice('画像を差し替えました');

                if (fileRef.current !== null) {
                  fileRef.current.value = '';
                }
              });
            }}
          />
        </label>

        <RichMenuPreview
          menu={menu}
          canvas={canvas}
          imageVersion={imageVersion}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">4. 行き先</h2>

        {liffBaseUrl === '' ? (
          <p className="text-sm text-red-700">
            <strong>LIFF のURLが設定されていません。</strong>
            先に「設定」で <code>LIFF_BASE_URL</code> を入れてください
          </p>
        ) : (
          <button
            type="button"
            className="self-start rounded-lg border p-2 text-sm"
            onClick={() => {
              update({
                areas: menu.areas.map((area) => {
                  const known = destinations.find((destination) =>
                    area.uri.endsWith(destination.path),
                  );

                  return known === undefined
                    ? area
                    : { ...area, uri: joinLiffUrl(liffBaseUrl, known.path) };
                }),
              });
              setError(null);
              setNotice('行き先をいまの設定に合わせました。保存してください');
            }}
          >
            行き先をいまの設定に合わせる
          </button>
        )}
        <p className="text-xs leading-relaxed">
          <strong>LIFF のIDを変えたら押してください。</strong>
          変えたままだと、ボタンを押しても何も起きなくなります
        </p>

        {menu.areas.length === 0 ? (
          <p className="text-sm">先に「2. 押す場所の型」を選んでください</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {menu.areas.map((area, index) => (
              <li key={index} className="rounded-lg border p-3">
                <p className="text-sm font-bold">{index + 1}つ目</p>

                <label className="mt-2 flex flex-col gap-1 text-sm">
                  {`${String(index + 1)}つ目のボタンの名前`}
                  <input
                    className="rounded-lg border p-2"
                    maxLength={20}
                    value={area.label}
                    onChange={(event) => {
                      updateArea(index, { label: event.target.value });
                    }}
                  />
                </label>

                <label className="mt-2 flex flex-col gap-1 text-sm">
                  {`${String(index + 1)}つ目の行き先`}
                  <select
                    className="rounded-lg border p-2"
                    value={
                      destinations.find((destination) =>
                        area.uri.endsWith(destination.path),
                      )?.path ?? ''
                    }
                    onChange={(event) => {
                      const path = event.target.value;

                      if (path === '') {
                        return;
                      }

                      const chosen = destinations.find(
                        (destination) => destination.path === path,
                      );

                      updateArea(index, {
                        uri: joinLiffUrl(liffBaseUrl, path),
                        // **名前が空なら画面の名前を入れておく**
                        ...(area.label === '' && chosen !== undefined
                          ? { label: chosen.label }
                          : {}),
                      });
                    }}
                  >
                    <option value="">選んでください</option>
                    {destinations.map((destination) => (
                      <option key={destination.path} value={destination.path}>
                        {destination.label}
                      </option>
                    ))}
                  </select>
                </label>

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">
                    URLと位置を手で直す
                  </summary>

                  <label className="mt-2 flex flex-col gap-1 text-xs">
                    {`${String(index + 1)}つ目のURL`}
                    <input
                      className="rounded-lg border p-2"
                      value={area.uri}
                      onChange={(event) => {
                        updateArea(index, { uri: event.target.value });
                      }}
                    />
                  </label>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        { key: 'x', label: '左から' },
                        { key: 'y', label: '上から' },
                        { key: 'width', label: '横' },
                        { key: 'height', label: '縦' },
                      ] as const
                    ).map((field) => (
                      <label
                        key={field.key}
                        className="flex flex-col gap-1 text-xs"
                      >
                        {`${String(index + 1)}つ目の${field.label}`}
                        <input
                          type="number"
                          className="w-24 rounded-lg border p-2"
                          value={area[field.key]}
                          onChange={(event) => {
                            const value = Number.parseInt(
                              event.target.value,
                              10,
                            );

                            updateArea(index, {
                              [field.key]: Number.isNaN(value) ? 0 : value,
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-bold">5. 保存して出す</h2>
        <p className="text-xs leading-relaxed">
          <strong>保存してもLINEには出ません。</strong>
          「LINEへ出す」を押すまで、いまのメニューのままです
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className="rounded-lg border p-3 text-sm disabled:opacity-50"
            onClick={() => {
              run(async () => {
                await saveRichMenu({
                  name: menu.name,
                  chatBarText: menu.chatBarText,
                  canvas: menu.canvas,
                  selected: menu.selected,
                  areas: menu.areas,
                });

                setNotice('保存しました。まだLINEには出ていません');
              });
            }}
          >
            保存する
          </button>

          <button
            type="button"
            disabled={busy || !ready}
            className="rounded-lg border p-3 text-sm disabled:opacity-50"
            onClick={() => {
              run(async () => {
                const { applied } = await applyRichMenu();

                update({
                  lineRichMenuId: applied.lineRichMenuId,
                  appliedAt: new Date().toISOString(),
                });

                setNotice(
                  applied.staleRichMenuId === null
                    ? 'LINEへ出しました'
                    : `LINEへ出しました。古いメニュー（${applied.staleRichMenuId}）が消せずに残っています。「いま出ているものを確かめる」から消してください`,
                );
              });
            }}
          >
            LINEへ出す
          </button>

          <button
            type="button"
            disabled={busy}
            className="rounded-lg border p-3 text-sm disabled:opacity-50"
            onClick={() => {
              run(async () => {
                const loaded = await fetchRichMenuState();

                setState(loaded.state);
              });
            }}
          >
            いま出ているものを確かめる
          </button>
        </div>

        {ready ? null : (
          <p className="text-xs leading-relaxed">
            <strong>
              画像と押す場所がそろうまで「LINEへ出す」は押せません。
            </strong>
            画像のないメニューはLINEが受け取りません
          </p>
        )}
      </section>

      {state === null ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-bold">
            LINEにあるメニュー（{state.remote.length} 件）
          </h2>

          {state.remote.length === 0 ? (
            <p className="text-sm">LINE側には何もありません</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.remote.map((entry) => {
                const isDefault = entry.richMenuId === state.defaultRichMenuId;

                return (
                  <li
                    key={entry.richMenuId}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
                  >
                    <span>{entry.name === '' ? '(名前なし)' : entry.name}</span>
                    <code className="text-xs">{entry.richMenuId}</code>
                    {isDefault ? (
                      <strong className="text-xs">全員に出ています</strong>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-lg border p-1 text-xs disabled:opacity-50"
                        onClick={() => {
                          run(async () => {
                            await removeRemoteRichMenu(entry.richMenuId);

                            setState({
                              ...state,
                              remote: state.remote.filter(
                                (row) => row.richMenuId !== entry.richMenuId,
                              ),
                            });
                            setNotice('消しました');
                          });
                        }}
                      >
                        消す
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-xs leading-relaxed">
            <strong>出ているものは消せません。</strong>
            消すと誰にもメニューが出なくなるためです
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * 絵の上に押す場所を重ねて見せる。
 *
 * **これが無いと座標が合っているか分からない。** 数字だけでは
 * 「1つ目が左上」しか分からず、ずれに気づけない。
 */
function RichMenuPreview({
  menu,
  canvas,
  imageVersion,
}: {
  menu: RichMenuJson;
  canvas: { width: number; height: number };
  imageVersion: number;
}) {
  if (!menu.hasImage) {
    return (
      <p className="text-sm">画像がまだありません。上から選んでください</p>
    );
  }

  return (
    <div
      className="relative w-full border"
      style={{
        aspectRatio: `${String(canvas.width)} / ${String(canvas.height)}`,
      }}
    >
      {/*
        `next/image` を使わない。**大きさが決まっていて外へ出ない絵**で、
        最適化する相手ではない
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/admin/rich-menu/image?v=${String(imageVersion)}`}
        alt="リッチメニューの画像"
        className="absolute inset-0 h-full w-full object-fill"
      />

      {menu.areas.map((area, index) => (
        <div
          key={index}
          className="absolute border-2 border-dashed border-blue-600 bg-blue-600/10"
          style={{
            left: `${String((area.x / canvas.width) * 100)}%`,
            top: `${String((area.y / canvas.height) * 100)}%`,
            width: `${String((area.width / canvas.width) * 100)}%`,
            height: `${String((area.height / canvas.height) * 100)}%`,
          }}
        >
          <span className="absolute left-0 top-0 bg-blue-600 px-1 text-xs text-white">
            {index + 1}
            {area.label === '' ? '' : `・${area.label}`}
          </span>
        </div>
      ))}
    </div>
  );
}
