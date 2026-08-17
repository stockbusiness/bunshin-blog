'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  PersonaApiError,
  createPersona,
  draftPersona,
  type PersonaInput,
} from '../../_lib/personas-api';
import { PersonaForm } from '../_components/persona-form';

/**
 * `/liff/personas/new` 分身をつくる（段4、D-14、Q-058・Q-047）。
 *
 * ## 23項目を3つに減らす
 *
 * **全部まじめに埋める人はいない。** 空のまま通れば AI は何も
 * 参照できず、**そのほうが精度は低い。**
 *
 * **項目は減らさない。3つ聞いて、残りをAIが下書きし、
 * 人が違うところだけ直す**（Q-058）。
 *
 * ## 聞く3つ
 *
 * | | 聞く理由 |
 * |---|---|
 * | 何について書きたいか | **本人の実際の関心。** AIが決めると30ブログが全部似る |
 * | 誰に向けて書くか | 同上 |
 * | どうなったらやめるか | **あえて残す唯一の「判断」** |
 *
 * **「やめる条件」をAIに決めさせない。** 先に決める理由が
 * 「後から決めるとかけた時間に引きずられるから」なので、
 * **AIが書いた条件では仕掛けそのものが無意味になる。**
 *
 * ## 手で全部入れる道を塞がない
 *
 * 下書きを使わずに書きたい人のために、**そのまま入力する道も残す。**
 */

interface Answers {
  fields: string;
  audience: string;
  exitCriteria: string;
}

const EMPTY_ANSWERS: Answers = { fields: '', audience: '', exitCriteria: '' };

/** 1行に1つ（Q-050 と同じ扱い）。空行は落とす */
export function readFields(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function messageOf(thrown: unknown): string {
  return thrown instanceof PersonaApiError
    ? thrown.message
    : '保存できませんでした';
}

const LABEL = 'flex flex-col gap-1 text-sm font-bold';
const INPUT = 'rounded-lg border p-3 text-base';
const HINT = 'text-xs leading-relaxed';

export default function NewPersonaPage() {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [draft, setDraft] = useState<PersonaInput | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready =
    readFields(answers.fields).length > 0 &&
    answers.audience.trim() !== '' &&
    answers.exitCriteria.trim() !== '';

  function run(action: () => Promise<void>): void {
    setBusy(true);
    setError(null);

    void action()
      .catch((thrown: unknown) => {
        setError(messageOf(thrown));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function save(input: PersonaInput): void {
    setBusy(true);
    setError(null);

    void createPersona(input).then(
      (result) => {
        router.push(`/liff/personas/${result.persona.id}`);
      },
      (thrown: unknown) => {
        setBusy(false);
        setError(messageOf(thrown));
      },
    );
  }

  // 下書きができたか、手で入れると決めたら、23項目の画面へ
  if (draft !== null || manual) {
    return (
      <main className="min-h-dvh p-4">
        <h1 className="text-lg font-bold">分身をつくる</h1>

        {draft === null ? (
          <p className="mt-1 text-xs leading-relaxed">
            つくった時点では下書きです。使い始めるのは、できてからで大丈夫です。
          </p>
        ) : (
          <p className="mt-2 rounded-lg border p-3 text-xs leading-relaxed">
            <strong>答えをもとに、残りを埋めました。</strong>
            合っていないところだけ直してください。
            <br />
            <strong>
              「専門領域」と「やめる条件」は、あなたが答えたままです。
            </strong>
          </p>
        )}

        <PersonaForm
          initial={draft ?? undefined}
          submitLabel="下書きとして保存する"
          submitting={busy}
          error={error}
          onSubmit={save}
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

  return (
    <main className="min-h-dvh p-4">
      <h1 className="text-lg font-bold">分身をつくる</h1>
      <p className="mt-1 text-xs leading-relaxed">
        <strong>3つだけ教えてください。</strong>
        残りはこちらで下書きします。あとから直せます
      </p>

      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <label className={LABEL}>
          何について書きたいですか
          <textarea
            className={`${INPUT} min-h-20`}
            value={answers.fields}
            placeholder={'格安SIM\n通信費の節約'}
            onChange={(event) => {
              setAnswers({ ...answers, fields: event.target.value });
            }}
          />
          <span className={HINT}>
            1行に1つ。<strong>あなたが実際に関心のあること</strong>
            を書いてください
          </span>
        </label>

        <label className={LABEL}>
          誰に向けて書きますか
          <input
            className={INPUT}
            value={answers.audience}
            placeholder="一人暮らしを始めたばかりの人"
            onChange={(event) => {
              setAnswers({ ...answers, audience: event.target.value });
            }}
          />
          <span className={HINT}>ふだんの言葉で大丈夫です</span>
        </label>

        {/*
          **AIに決めさせない**（Q-058）。先に決める理由が
          「後から決めるとかけた時間に引きずられるから」なので、
          AIが書いた条件では仕掛けそのものが無意味になる
        */}
        <label className={LABEL}>
          どうなったらやめますか
          <input
            className={INPUT}
            value={answers.exitCriteria}
            placeholder="3か月やって月1,000円に届かなければやめる"
            onChange={(event) => {
              setAnswers({ ...answers, exitCriteria: event.target.value });
            }}
          />
          <span className={HINT}>
            <strong>ここだけは、ご自身で決めてください。</strong>
            後から決めると、かけた時間に引きずられて続けてしまいます
          </span>
        </label>

        <button
          type="button"
          disabled={busy || !ready}
          className="rounded-lg border p-4 text-base font-bold disabled:opacity-50"
          onClick={() => {
            run(async () => {
              const result = await draftPersona({
                fields: readFields(answers.fields),
                audience: answers.audience.trim(),
                exitCriteria: answers.exitCriteria.trim(),
              });

              setDraft(result.draft);
            });
          }}
        >
          {busy ? '下書きをつくっています' : '残りを下書きしてもらう'}
        </button>

        {/* **手で全部入れる道を塞がない** */}
        <button
          type="button"
          disabled={busy}
          className="text-xs underline disabled:opacity-50"
          onClick={() => {
            setManual(true);
          }}
        >
          全部じぶんで入力する
        </button>
      </div>

      <Link
        href="/liff/personas"
        className="mt-6 block text-center text-xs underline"
      >
        一覧へ戻る
      </Link>
    </main>
  );
}
