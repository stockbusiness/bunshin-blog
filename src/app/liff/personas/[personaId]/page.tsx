'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import {
  PersonaApiError,
  changePersonaStatus,
  fetchPersona,
  savePersona,
  type PersonaJson,
} from '../../_lib/personas-api';
import {
  PERSONA_STATUS_LABELS,
  PERSONA_TYPE_LABELS,
} from '../../_lib/persona-labels';
import { PersonaForm, toPersonaInput } from '../_components/persona-form';

/**
 * `/liff/personas/[personaId]` 分身の詳細（TASKS D-14）。
 *
 * 編集と、使い始める／止めるを1画面に置く。
 *
 * **断られた理由はサーバーの文言をそのまま出す。** 段階解放で断るとき、
 * `activatePersonaForUser` は経過日数まで含めた文を返す（A-2-R-2b）。
 * ここで言い換えると、**待てば開くのかが伝わらなくなる。**
 *
 * **消す操作は置かない。** 途中でやめた分身があること自体が実験の記録。
 */
export default function PersonaDetailPage({
  params,
}: {
  params: Promise<{ personaId: string }>;
}) {
  const { personaId } = use(params);

  const [persona, setPersona] = useState<PersonaJson | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void fetchPersona(personaId).then(
      (result) => {
        if (!cancelled) setPersona(result.persona);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setLoadError(
            thrown instanceof PersonaApiError
              ? thrown.message
              : '読み込めませんでした',
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [personaId]);

  if (loadError !== null) {
    return <p className="p-6 text-sm leading-relaxed">{loadError}</p>;
  }

  if (persona === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  const isActive = persona.status === 'ACTIVE';

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">{persona.name}</h1>
      <p className="mt-1 text-xs">
        {PERSONA_TYPE_LABELS[persona.personaType]}・
        {PERSONA_STATUS_LABELS[persona.status]}
      </p>

      <section className="mt-4 rounded-lg border p-4">
        <h2 className="text-sm font-bold">使う・休む</h2>
        <p className="mt-1 text-xs leading-relaxed">
          {isActive
            ? '休むと、この分身のブログへの提案が止まります。記事は消えません。'
            : '使い始めると、この分身でブログをつくれるようになります。'}
        </p>

        {statusError === null ? null : (
          <p role="alert" className="mt-3 text-sm leading-relaxed">
            {statusError}
          </p>
        )}

        <button
          type="button"
          disabled={changing}
          className="mt-3 w-full rounded-lg border p-3 text-sm font-bold disabled:opacity-50"
          onClick={() => {
            setChanging(true);
            setStatusError(null);

            void changePersonaStatus(
              persona.id,
              isActive ? 'PAUSE' : 'ACTIVATE',
            ).then(
              (result) => {
                setChanging(false);
                setPersona(result.persona);
              },
              (thrown: unknown) => {
                setChanging(false);
                // **サーバーの文言をそのまま出す。** 段階解放の理由
                // （経過日数）が含まれている
                setStatusError(
                  thrown instanceof PersonaApiError
                    ? thrown.message
                    : '変更できませんでした',
                );
              },
            );
          }}
        >
          {isActive ? '休む' : '使い始める'}
        </button>
      </section>

      <h2 className="mt-6 text-sm font-bold">設定を変える</h2>
      {saved ? <p className="mt-1 text-xs">保存しました</p> : null}

      <PersonaForm
        key={persona.id}
        initial={toPersonaInput(persona)}
        submitLabel="保存する"
        submitting={submitting}
        error={saveError}
        onSubmit={(input) => {
          setSubmitting(true);
          setSaveError(null);
          setSaved(false);

          void savePersona(persona.id, input).then(
            (result) => {
              setSubmitting(false);
              setPersona(result.persona);
              setSaved(true);
            },
            (thrown: unknown) => {
              setSubmitting(false);
              setSaveError(
                thrown instanceof PersonaApiError
                  ? thrown.message
                  : '保存できませんでした',
              );
            },
          );
        }}
      />

      <Link
        href="/liff/personas"
        className="mt-4 block text-center text-xs underline"
      >
        一覧へ戻る
      </Link>
    </main>
  );
}
