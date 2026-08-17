/**
 * 3つの答えから分身の下書きを作る（Q-058、Q-047、段4）。
 *
 * ## なぜ作るのか
 *
 * 段4は**23項目**あった。**全部まじめに埋める人はいない。**
 * 空のまま通れば AI は何も参照できず、**そのほうが精度は低い。**
 *
 * **項目は減らさない。AIが埋めて、人が違うところだけ直す**
 * （Q-058。Q-053 でLPから事実を読み取ったのと同じ形）。
 * 実際に埋まる分だけ、いまより精度は上がる。
 *
 * ## 本人に聞くのは3つだけ
 *
 * | | 聞く理由 |
 * |---|---|
 * | 専門領域 | **本人の実際の関心。** AIが決めると30ブログが全部似る |
 * | 読者 | 同上 |
 * | やめる条件 | **あえて残す唯一の「判断」**（下記） |
 *
 * **「やめる条件」をAIに決めさせない。** ROADMAP が「先に決める」と
 * しているのは、**後から決めるとかけた時間に引きずられるから**である。
 * AIが書いた条件では、**この仕掛けそのものが無意味になる。**
 *
 * ## 答えた3つをAIに書き換えさせない
 *
 * 返ってきた下書きのうち、**`fields` と `exitCriteria` は本人の答えで
 * 上書きする。** AIが「もっと良い言い方」に直してしまうと、
 * **本人が決めたはずのものが本人のものでなくなる。**
 *
 * **`draftSchema` にこの2つを入れない。** zod は知らない鍵を落とすので、
 * **AIが返しても解析の時点で消える。** 上書きと合わせて二重に守る —
 * どちらか一方を崩しても、もう一方が残る。
 */

import { z } from 'zod';
import type { AiOperation, AiProvider } from '@/lib/ai';
import { AppError } from '@/lib/errors';
import type {
  PersonaAudience,
  PersonaBusiness,
  PersonaExpertise,
  PersonaIdentity,
  PersonaType,
} from './persona';

/** 文章を書かせるので標準の段（SPEC 9.8）。分類ではない */
const OPERATION: AiOperation = 'PERSONA_DRAFT';

/**
 * 下書きなので少し振れてよい。
 *
 * **0にしない。** 30ブログが全部同じ文体になると、
 * 実験の一次データとして意味を失う。
 */
const TEMPERATURE_DRAFT = 0.7;

/** 本人に聞く3つ */
export interface PersonaAnswers {
  /** 何について書きたいか。**1つ以上** */
  fields: readonly string[];
  /** 誰に向けて書くか。そのままの言葉でよい */
  audience: string;
  /** どうなったらやめるか。**AIに書き換えさせない** */
  exitCriteria: string;
}

export interface PersonaDraft {
  name: string;
  personaType: PersonaType;
  identity: PersonaIdentity;
  expertise: PersonaExpertise;
  audience: PersonaAudience;
  business: PersonaBusiness;
}

const EMOJI_LEVELS = ['none', 'low', 'mid'] as const;
const LINE_BREAKS = ['short', 'normal'] as const;
const KNOWLEDGE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
const PERSONA_TYPES = ['SELF', 'IDEAL', 'CHARACTER'] as const;

const line = z.string().trim().min(1).max(200);
const lines = z.array(line).min(1).max(8);

const draftSchema = z.object({
  name: z.string().trim().min(1).max(50),
  personaType: z.enum(PERSONA_TYPES),
  identity: z.object({
    name: z.string().trim().min(1).max(50),
    firstPerson: z.string().trim().min(1).max(10),
    background: z.string().trim().min(1).max(500),
    tone: z.object({
      style: z.string().trim().min(1).max(200),
      emojiLevel: z.enum(EMOJI_LEVELS),
      lineBreak: z.enum(LINE_BREAKS),
      politeness: z.string().trim().min(1).max(200),
    }),
    values: z.object({ priorities: lines, avoid: lines }),
    ngExpressions: lines,
  }),
  expertise: z.object({
    sources: lines,
    evaluationCriteria: lines,
  }),
  audience: z.object({
    ageRange: z.string().trim().min(1).max(50),
    situation: z.string().trim().min(1).max(300),
    knowledgeLevel: z.enum(KNOWLEDGE_LEVELS),
    problems: lines,
    searchIntents: lines,
  }),
  business: z.object({
    revenuePolicy: z.string().trim().min(1).max(300),
    monthlyGoalYen: z.number().int().min(0).max(10_000_000),
    kpis: lines,
  }),
});

export interface DraftPersonaDeps {
  provider: AiProvider;
}

/**
 * 3つの答えから、残りの20項目を下書きする。
 *
 * **保存しない。** 返した下書きは画面に出て、
 * **人が直してから**登録される。
 *
 * @throws {AppError} 答えが足りないとき、AIの応答が読めなかったとき
 */
export async function draftPersonaFromAnswers(
  answers: PersonaAnswers,
  deps: DraftPersonaDeps,
): Promise<PersonaDraft> {
  const fields = answers.fields
    .map((field) => field.trim())
    .filter((field) => field !== '');

  if (fields.length === 0) {
    throw AppError.validationFailed('何について書きたいかを入れてください');
  }

  if (answers.audience.trim() === '') {
    throw AppError.validationFailed('誰に向けて書くかを入れてください');
  }

  if (answers.exitCriteria.trim() === '') {
    throw AppError.validationFailed('やめる条件を入れてください');
  }

  const result = await deps.provider.complete({
    operation: OPERATION,
    system: [
      'あなたはブログを書く「分身」の人物像を組み立てる係です。',
      '渡された3つの答えをもとに、記事を書くための人物像を下書きしてください。',
      '',
      '**答えられた3つを書き換えないでください。** 足りない項目だけを補います。',
      '**実在の人物や企業を出さないでください。**',
      '**数値の目標は控えめにしてください**（月1万円程度から）。',
      '**専門家を名乗らせないでください** — 資格や実績を作らないこと。',
      '',
      'JSONだけを返してください。形は次のとおりです。',
      JSON.stringify(SHAPE_HINT),
      '',
      'emojiLevel は none / low / mid、lineBreak は short / normal、',
      'knowledgeLevel は beginner / intermediate / advanced、',
      'personaType は SELF / IDEAL / CHARACTER から選んでください。',
      '前置き・後書き・コードフェンスを付けないでください。',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `何について書きたいか：${fields.join('、')}`,
          `誰に向けて書くか：${answers.audience.trim()}`,
          `やめる条件：${answers.exitCriteria.trim()}`,
        ].join('\n'),
      },
    ],
    maxOutputTokens: 2_000,
    temperature: TEMPERATURE_DRAFT,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(result.text));
  } catch {
    // **応答本文を例外へ載せない**（SPEC 14.2）
    throw AppError.validationFailed(
      '下書きを作れませんでした。手で入力してください',
    );
  }

  const draft = draftSchema.safeParse(parsed);

  if (!draft.success) {
    throw AppError.validationFailed(
      '下書きを作れませんでした。手で入力してください',
    );
  }

  return {
    ...draft.data,
    expertise: {
      // **本人の答えをそのまま使う。** AIに書き換えさせない
      fields,
      sources: draft.data.expertise.sources,
      evaluationCriteria: draft.data.expertise.evaluationCriteria,
    },
    business: {
      ...draft.data.business,
      // **やめる条件は本人のもの**（上記）
      exitCriteria: answers.exitCriteria.trim(),
    },
  };
}

/** AIへ渡す形の見本。**`fields` と `exitCriteria` は含めない**（本人の答え） */
const SHAPE_HINT = {
  name: '分身の呼び名',
  personaType: 'SELF',
  identity: {
    name: '記事に出す名前',
    firstPerson: '私',
    background: 'どんな人か',
    tone: {
      style: '文体',
      emojiLevel: 'low',
      lineBreak: 'normal',
      politeness: '丁寧さ',
    },
    values: { priorities: ['大事にすること'], avoid: ['避けること'] },
    ngExpressions: ['使わない表現'],
  },
  expertise: {
    sources: ['よく見る情報源'],
    evaluationCriteria: ['良し悪しの判断基準'],
  },
  audience: {
    ageRange: '読者の年代',
    situation: '読者の状況',
    knowledgeLevel: 'beginner',
    problems: ['読者の悩み'],
    searchIntents: ['読者が検索しそうな言葉'],
  },
  business: {
    revenuePolicy: '収益の方針',
    monthlyGoalYen: 10000,
    kpis: ['見る指標'],
  },
};

/** コードフェンスが付いてきた場合に剥がす（`offer-draft` と同じ） */
function stripFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}
