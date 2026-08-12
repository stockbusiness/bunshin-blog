'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  PersonaApiError,
  fetchPersonas,
  type PersonaListJson,
} from '../_lib/personas-api';
import {
  PERSONA_STATUS_LABELS,
  PERSONA_TYPE_LABELS,
  describePersonaLimits,
} from '../_lib/persona-labels';

/**
 * `/liff/personas` 分身の一覧（TASKS D-14、ROADMAP 2章）。
 *
 * **分身が主、媒体が従。** ブログは分身が無いと作れないので、ここが入口。
 *
 * **上限は数だけでなく理由を出す**（`describePersonaLimits`）。
 * 「上限です」だけだと、待てば開くのか、止めれば開くのかが分からない。
 *
 * **`ARCHIVED` も一覧に出す。** 途中でやめた分身があること自体が実験の記録で、
 * 消すと「最初から作らなかった」と区別できない。
 */
export default function PersonaListPage() {
  const [data, setData] = useState<PersonaListJson | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchPersonas().then(
      (result) => {
        if (!cancelled) setData(result);
      },
      (thrown: unknown) => {
        if (!cancelled) {
          setError(
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
  }, []);

  if (error !== null) {
    return <p className="p-6 text-sm leading-relaxed">{error}</p>;
  }

  if (data === null) {
    return <p className="p-6 text-sm">読み込んでいます</p>;
  }

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">分身</h1>
      <p className="mt-1 text-xs leading-relaxed">
        {describePersonaLimits(data.limits)}
      </p>

      {data.personas.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed">
          まだ分身がいません。ブログは分身が書くので、まず1体つくります。
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {data.personas.map((persona) => (
            <li key={persona.id} className="rounded-lg border p-4">
              <Link
                href={`/liff/personas/${persona.id}`}
                className="block"
                aria-label={`${persona.name} を開く`}
              >
                <p className="text-base font-bold">{persona.name}</p>
                <p className="mt-1 text-xs">
                  {PERSONA_TYPE_LABELS[persona.personaType]}・
                  {PERSONA_STATUS_LABELS[persona.status]}
                </p>
                <p className="mt-2 text-xs">
                  {persona.expertise.fields.join('、')}
                </p>
                <p className="mt-2 text-xs underline">開く</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/liff/personas/new"
        className="mt-6 block rounded-lg border p-3 text-center text-sm font-bold"
      >
        分身をつくる
      </Link>
    </main>
  );
}
