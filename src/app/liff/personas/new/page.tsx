'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PersonaApiError, createPersona } from '../../_lib/personas-api';
import { PersonaForm } from '../_components/persona-form';

/**
 * `/liff/personas/new` 分身をつくる（TASKS D-14）。
 *
 * **つくった直後は下書き。** 使い始めるのは一覧か詳細から別の操作にする
 * （A-2-R-2a）。同じ画面でまとめると、**上限に当たったときに入力ごと
 * 失われる。**
 */
export default function NewPersonaPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">分身をつくる</h1>
      <p className="mt-1 text-xs leading-relaxed">
        つくった時点では下書きです。使い始めるのは、できてからで大丈夫です。
      </p>

      <PersonaForm
        submitLabel="下書きとして保存する"
        submitting={submitting}
        error={error}
        onSubmit={(input) => {
          setSubmitting(true);
          setError(null);

          void createPersona(input).then(
            (result) => {
              router.push(`/liff/personas/${result.persona.id}`);
            },
            (thrown: unknown) => {
              setSubmitting(false);
              setError(
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
