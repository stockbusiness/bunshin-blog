'use client';

import { useId, useState } from 'react';
import type { PersonaInput, PersonaJson } from '../../_lib/personas-api';
import {
  EMOJI_LEVEL_LABELS,
  EMOJI_LEVEL_VALUES,
  KNOWLEDGE_LEVEL_LABELS,
  KNOWLEDGE_LEVEL_VALUES,
  LINE_BREAK_LABELS,
  LINE_BREAK_VALUES,
  PERSONA_TYPE_LABELS,
  PERSONA_TYPE_VALUES,
} from '../../_lib/persona-labels';

/**
 * 分身の入力フォーム（D-14）。**新規と編集で同じものを使う。**
 *
 * 分けると、片方だけに項目が足された状態がいずれ生まれる。
 *
 * ## 一覧の入力
 *
 * 配列（大事にすること・専門領域など）は**改行区切りの1つの欄**で受ける。
 * 行を足すボタンにすると、LINEアプリ内のブラウザで**操作が増えるだけ**で、
 * 入る値は変わらない。
 *
 * ## 検証はサーバーが持つ
 *
 * **ここで規則を書かない**（`normalizeCreatePersona`）。同じ規則を2か所に
 * 置くと、いずれ食い違う。空欄のまま送ればサーバーの文言が返る。
 */

const EMPTY: PersonaInput = {
  name: '',
  personaType: 'SELF',
  identity: {
    name: '',
    firstPerson: '',
    background: '',
    tone: {
      style: '',
      emojiLevel: 'low',
      lineBreak: 'normal',
      politeness: '',
    },
    values: { priorities: [], avoid: [] },
    ngExpressions: [],
  },
  expertise: { fields: [], sources: [], evaluationCriteria: [] },
  audience: {
    ageRange: '',
    situation: '',
    knowledgeLevel: 'beginner',
    problems: [],
    searchIntents: [],
  },
  business: {
    revenuePolicy: '',
    monthlyGoalYen: 0,
    kpis: [],
    exitCriteria: '',
  },
};

export function toPersonaInput(persona: PersonaJson): PersonaInput {
  return {
    name: persona.name,
    personaType: persona.personaType,
    identity: persona.identity,
    expertise: persona.expertise,
    audience: persona.audience,
    business: persona.business,
  };
}

/** 改行区切りの入力を配列へ。**空行は落とす**（数えたときに合わなくなる） */
function toList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function fromList(values: string[]): string {
  return values.join('\n');
}

const FIELD_CLASS = 'mt-1 w-full rounded border p-2 text-sm';

function TextField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <p className="mt-3">
      <label htmlFor={id} className="text-xs font-bold">
        {label}
      </label>
      {hint === undefined ? null : (
        <span className="mt-1 block text-xs">{hint}</span>
      )}
      <input
        id={id}
        type="text"
        className={FIELD_CLASS}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </p>
  );
}

/**
 * 改行区切りの一覧。
 *
 * **打った文字はそのまま持ち、配列は親へ渡すだけにする。**
 * `value` を `fromList(values)` にすると、`toList` が空行を落とすため
 * **改行を打った瞬間に消え、2行目を打てなくなる。**
 */
function ListField({
  label,
  values,
  hint,
  onChange,
}: {
  label: string;
  values: string[];
  hint: string;
  onChange: (values: string[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState(() => fromList(values));

  return (
    <p className="mt-3">
      <label htmlFor={id} className="text-xs font-bold">
        {label}
      </label>
      <span className="mt-1 block text-xs">{hint}</span>
      <textarea
        id={id}
        rows={3}
        className={FIELD_CLASS}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(toList(event.target.value));
        }}
      />
    </p>
  );
}

function SelectField<T extends string>({
  label,
  value,
  values,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  const id = useId();

  return (
    <p className="mt-3">
      <label htmlFor={id} className="text-xs font-bold">
        {label}
      </label>
      <select
        id={id}
        className={FIELD_CLASS}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {values.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </p>
  );
}

export function PersonaForm({
  initial,
  submitLabel,
  submitting,
  error,
  onSubmit,
}: {
  initial?: PersonaInput | undefined;
  submitLabel: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: PersonaInput) => void;
}) {
  const [form, setForm] = useState<PersonaInput>(initial ?? EMPTY);

  const identity = form.identity;
  const tone = identity.tone;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}
    >
      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">この分身は誰か</legend>

        <TextField
          label="分身の呼び名"
          hint="自分が見分けるための名前です（例：節約の人）"
          value={form.name}
          onChange={(name) => {
            setForm({ ...form, name });
          }}
        />

        <SelectField
          label="種類"
          value={form.personaType}
          values={PERSONA_TYPE_VALUES}
          labels={PERSONA_TYPE_LABELS}
          onChange={(personaType) => {
            setForm({ ...form, personaType });
          }}
        />

        <TextField
          label="記事に出す名前"
          value={identity.name}
          onChange={(name) => {
            setForm({ ...form, identity: { ...identity, name } });
          }}
        />

        <TextField
          label="一人称"
          hint="記事の文体を決めます（例：私、僕）"
          value={identity.firstPerson}
          onChange={(firstPerson) => {
            setForm({ ...form, identity: { ...identity, firstPerson } });
          }}
        />

        <TextField
          label="背景"
          hint="どんな人かを一言で（例：30代の会社員。家計の見直しが趣味）"
          value={identity.background}
          onChange={(background) => {
            setForm({ ...form, identity: { ...identity, background } });
          }}
        />
      </fieldset>

      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">書き方</legend>

        <TextField
          label="文体"
          hint="例：やわらかい語り口"
          value={tone.style}
          onChange={(style) => {
            setForm({
              ...form,
              identity: { ...identity, tone: { ...tone, style } },
            });
          }}
        />

        <SelectField
          label="絵文字"
          value={tone.emojiLevel}
          values={EMOJI_LEVEL_VALUES}
          labels={EMOJI_LEVEL_LABELS}
          onChange={(emojiLevel) => {
            setForm({
              ...form,
              identity: { ...identity, tone: { ...tone, emojiLevel } },
            });
          }}
        />

        <SelectField
          label="改行"
          value={tone.lineBreak}
          values={LINE_BREAK_VALUES}
          labels={LINE_BREAK_LABELS}
          onChange={(lineBreak) => {
            setForm({
              ...form,
              identity: { ...identity, tone: { ...tone, lineBreak } },
            });
          }}
        />

        <TextField
          label="丁寧さ"
          hint="例：です・ます"
          value={tone.politeness}
          onChange={(politeness) => {
            setForm({
              ...form,
              identity: { ...identity, tone: { ...tone, politeness } },
            });
          }}
        />

        <ListField
          label="大事にすること"
          hint="1行に1つ（例：正確さ）"
          values={identity.values.priorities}
          onChange={(priorities) => {
            setForm({
              ...form,
              identity: {
                ...identity,
                values: { ...identity.values, priorities },
              },
            });
          }}
        />

        <ListField
          label="避けること"
          hint="1行に1つ（例：煽り）"
          values={identity.values.avoid}
          onChange={(avoid) => {
            setForm({
              ...form,
              identity: { ...identity, values: { ...identity.values, avoid } },
            });
          }}
        />

        <ListField
          label="使わない表現"
          hint="1行に1つ（例：絶対に儲かる）"
          values={identity.ngExpressions}
          onChange={(ngExpressions) => {
            setForm({ ...form, identity: { ...identity, ngExpressions } });
          }}
        />
      </fieldset>

      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">得意なこと</legend>

        <ListField
          label="専門領域"
          hint="1行に1つ。**1つ以上が必要です**（何を書く人かが決まります）"
          values={form.expertise.fields}
          onChange={(fields) => {
            setForm({ ...form, expertise: { ...form.expertise, fields } });
          }}
        />

        <ListField
          label="よく見る情報源"
          hint="1行に1つ（例：総務省統計）"
          values={form.expertise.sources}
          onChange={(sources) => {
            setForm({ ...form, expertise: { ...form.expertise, sources } });
          }}
        />

        <ListField
          label="良し悪しの判断基準"
          hint="1行に1つ（例：自分で使ったかどうか）"
          values={form.expertise.evaluationCriteria}
          onChange={(evaluationCriteria) => {
            setForm({
              ...form,
              expertise: { ...form.expertise, evaluationCriteria },
            });
          }}
        />
      </fieldset>

      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">誰に向けて書くか</legend>

        <TextField
          label="読者の年代"
          value={form.audience.ageRange}
          onChange={(ageRange) => {
            setForm({ ...form, audience: { ...form.audience, ageRange } });
          }}
        />

        <TextField
          label="読者の状況"
          hint="例：子育て中で時間が無い"
          value={form.audience.situation}
          onChange={(situation) => {
            setForm({ ...form, audience: { ...form.audience, situation } });
          }}
        />

        <SelectField
          label="読者の詳しさ"
          value={form.audience.knowledgeLevel}
          values={KNOWLEDGE_LEVEL_VALUES}
          labels={KNOWLEDGE_LEVEL_LABELS}
          onChange={(knowledgeLevel) => {
            setForm({
              ...form,
              audience: { ...form.audience, knowledgeLevel },
            });
          }}
        />

        <ListField
          label="読者の悩み"
          hint="1行に1つ（例：固定費が下がらない）"
          values={form.audience.problems}
          onChange={(problems) => {
            setForm({ ...form, audience: { ...form.audience, problems } });
          }}
        />

        <ListField
          label="読者が検索しそうな言葉"
          hint="1行に1つ（例：格安SIM 比較）"
          values={form.audience.searchIntents}
          onChange={(searchIntents) => {
            setForm({ ...form, audience: { ...form.audience, searchIntents } });
          }}
        />
      </fieldset>

      <fieldset className="mt-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-bold">目標とやめどき</legend>

        <TextField
          label="収益の方針"
          hint="例：自分で使ったものだけ紹介する"
          value={form.business.revenuePolicy}
          onChange={(revenuePolicy) => {
            setForm({ ...form, business: { ...form.business, revenuePolicy } });
          }}
        />

        <MonthlyGoalField
          value={form.business.monthlyGoalYen}
          onChange={(monthlyGoalYen) => {
            setForm({
              ...form,
              business: { ...form.business, monthlyGoalYen },
            });
          }}
        />

        <ListField
          label="見る指標"
          hint="1行に1つ（例：成果件数）"
          values={form.business.kpis}
          onChange={(kpis) => {
            setForm({ ...form, business: { ...form.business, kpis } });
          }}
        />

        <TextField
          label="やめる条件"
          hint="**先に決めます。** 後から決めると、かけた時間に引きずられます"
          value={form.business.exitCriteria}
          onChange={(exitCriteria) => {
            setForm({ ...form, business: { ...form.business, exitCriteria } });
          }}
        />
      </fieldset>

      {error === null ? null : (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 w-full rounded-lg border p-3 text-sm font-bold disabled:opacity-50"
      >
        {submitting ? '保存しています' : submitLabel}
      </button>
    </form>
  );
}

/**
 * 月間目標額。
 *
 * **空欄を 0 として送る。** `undefined` にすると「未入力」と「0円」の
 * 区別がサーバーへ届かず、必須の判定が効かなくなる。
 */
function MonthlyGoalField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();

  return (
    <p className="mt-3">
      <label htmlFor={id} className="text-xs font-bold">
        月にいくら目指すか（円）
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step={1000}
        className={FIELD_CLASS}
        value={String(value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? Math.trunc(parsed) : 0);
        }}
      />
    </p>
  );
}
