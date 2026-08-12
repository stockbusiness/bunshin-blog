/**
 * LINE返信の取り込み（TASKS D-7b、SPEC 8.4、Q-015）。
 *
 * 分類（D-7a）の結果を受けて、**`persona_facts` へ保存するか、
 * 画面へ案内するか**を決める。
 *
 * ## 保存できるとは限らない
 *
 * `persona_facts.persona_id` は **NOT NULL**（A-2-R-4。記憶は分身に溜まる）。
 * ところが **LINEのテキスト返信には、どの分身への返信かを示す情報が無い。**
 *
 * 分身が1体しかいなければ迷いようが無いので保存する。
 * **2体以上いるときは決めない** — 取り違えると、**その分身が
 * 持っていない経験を持っていることになる。** 記事はその記憶から
 * 一人称で書かれるので、嘘が本文に出る。
 *
 * 割り当て方は未決（OPEN_QUESTIONS Q-037）。決まるまでは案内に留める。
 *
 * ## 一人称で使ってよいのは、分類が確かなものだけ
 *
 * `PRODUCT_REVIEW` と `ADVICE` は語で見分けが付いた返信で、
 * 本人が自分のこととして書いている。`FREE_ANSWER` は**迷った結果の
 * 受け皿**なので、一人称では使わせない（**推測を確定として保存しない**）。
 *
 * ## 案内は push で送る
 *
 * **返信トークン（`replyToken`）を使わない。** 1分ほどで切れるため、
 * ジョブに載せて実行する頃には使えない。宛先は
 * `findNotificationTargetForUser` から取る（**退会・停止した人へ送らない**）。
 */

import { logger } from '@/lib/logger';
import { requireLineClient, type LineClient } from '@/lib/line';
import {
  createPersonaFactForUser,
  listPersonaFactsForUser,
  listPersonasForUser,
} from '@/modules/personas';
import { getRuntimeEnv } from '@/modules/settings';
import { findNotificationTargetForUser } from '@/modules/users';
import { classifyLineReply, type ReplyKind } from './reply-classification';
import { lineNotConfiguredError } from './errors';

/** 返信をどう扱ったか */
export type ReplyOutcome =
  /** `persona_facts` に保存した */
  | 'SAVED'
  /** 同じ内容が既にあった（ジョブの再実行） */
  | 'ALREADY_SAVED'
  /** 修正希望。**宛先の承認が決まらない**ので保存しない */
  | 'REVISION_REQUEST'
  /** 分身が2体以上あり、どれの記憶か決められない（Q-037） */
  | 'PERSONA_AMBIGUOUS'
  /** 分身がまだ1体も無い */
  | 'NO_PERSONA';

export interface ReplyIntakeResult {
  kind: ReplyKind;
  outcome: ReplyOutcome;
  /** 案内を送ったか。**保存できたときは送らない**（送ると毎回返事が来る） */
  guided: boolean;
}

export interface ReplyIntakeDeps {
  client?: LineClient | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * 案内の文面。
 *
 * **何が起きたかと、次にどこへ行けばよいかだけを書く。** 返信の中身を
 * 引用しない（LINE の通知一覧に本人の文が二度出る）。
 */
const GUIDANCE: Readonly<
  Record<
    Exclude<ReplyOutcome, 'SAVED' | 'ALREADY_SAVED'>,
    {
      text: string;
      path: string;
      label: string;
    }
  >
> = {
  REVISION_REQUEST: {
    text: [
      '修正のご希望は、承認画面からお願いします。',
      'どの記事への修正かが分かるようにするためです（この返信からは特定できません）。',
    ].join('\n'),
    path: '/approvals',
    label: '承認画面をひらく',
  },
  PERSONA_AMBIGUOUS: {
    text: [
      'ありがとうございます。どの分身の記憶にするかが決められませんでした。',
      '分身の画面から入力していただけると、正しい分身に残ります。',
    ].join('\n'),
    path: '/personas',
    label: '分身の画面をひらく',
  },
  NO_PERSONA: {
    text: [
      'ありがとうございます。まだ分身が作られていないため、記憶として残せませんでした。',
      '分身を作ってから、もう一度お送りください。',
    ].join('\n'),
    path: '/personas',
    label: '分身をつくる',
  },
};

function createClient(
  env: Readonly<Record<string, string | undefined>>,
): LineClient {
  try {
    return requireLineClient({ ...env });
  } catch {
    // **不足している変数名だけを見せる。** 値はログにも出さない（SPEC 14.2）
    throw lineNotConfiguredError(['LINE_CHANNEL_ACCESS_TOKEN']);
  }
}

/**
 * 案内を送る。
 *
 * **送れなくても例外にしない。** 案内が届かないことより、
 * ジョブが失敗して同じ返信が何度も処理されるほうが困る。
 */
async function guide(params: {
  userId: string;
  eventId: string;
  outcome: Exclude<ReplyOutcome, 'SAVED' | 'ALREADY_SAVED'>;
  deps: ReplyIntakeDeps;
}): Promise<boolean> {
  const guidance = GUIDANCE[params.outcome];

  try {
    const env = params.deps.env ?? (await getRuntimeEnv());
    const to = await findNotificationTargetForUser(params.userId);

    if (to === null) {
      return false;
    }

    const liffBaseUrl = env['LIFF_BASE_URL']?.trim() ?? '';

    if (liffBaseUrl === '') {
      return false;
    }

    const client = params.deps.client ?? createClient(env);

    await client.push({
      to,
      messages: [
        {
          type: 'template',
          altText: guidance.text,
          template: {
            type: 'buttons',
            title: 'BUNSHIN BLOG',
            text: guidance.text,
            actions: [
              {
                type: 'uri',
                label: guidance.label,
                uri: `${liffBaseUrl.replace(/\/+$/, '')}${guidance.path}`,
              },
            ],
          },
        },
      ],
      // **同じ返信に二度案内しない。** ジョブが再実行されても LINE 側で止まる
      retryKey: params.eventId,
    });

    return true;
  } catch {
    // **中身を残さない。** 返信の本文も宛先も出さない（SPEC 14.2）
    logger.error('LINE返信への案内を送れなかった', { eventId: params.eventId });

    return false;
  }
}

/**
 * 返信を取り込む。
 *
 * @param params.eventId `webhookEventId`。**再送でも同じ値**で、
 *   案内の重複を止める鍵に使う
 */
export async function recordLineReplyForUser(
  params: { userId: string; text: string; eventId: string },
  deps: ReplyIntakeDeps = {},
): Promise<ReplyIntakeResult> {
  const classification = classifyLineReply(params.text);
  const { kind, factType } = classification;

  if (factType === null) {
    // 修正希望。**保存しない**（宛先の承認が決まらない）
    const guided = await guide({
      userId: params.userId,
      eventId: params.eventId,
      outcome: 'REVISION_REQUEST',
      deps,
    });

    return { kind, outcome: 'REVISION_REQUEST', guided };
  }

  // **`ACTIVE` の分身だけを数える。** 下書きや休止中の分身へ記憶を足すと、
  // 使い始めたときに身に覚えのない経験が入っている
  const personas = (await listPersonasForUser(params.userId)).filter(
    (persona) => persona.status === 'ACTIVE',
  );

  if (personas.length === 0) {
    const guided = await guide({
      userId: params.userId,
      eventId: params.eventId,
      outcome: 'NO_PERSONA',
      deps,
    });

    return { kind, outcome: 'NO_PERSONA', guided };
  }

  if (personas.length > 1) {
    // **決めない**（Q-037）。取り違えると、その分身が持っていない経験になる
    const guided = await guide({
      userId: params.userId,
      eventId: params.eventId,
      outcome: 'PERSONA_AMBIGUOUS',
      deps,
    });

    return { kind, outcome: 'PERSONA_AMBIGUOUS', guided };
  }

  const persona = personas[0];

  if (persona === undefined) {
    return { kind, outcome: 'NO_PERSONA', guided: false };
  }

  const content = params.text.trim();

  // **同じ内容が既にあれば作らない。** ジョブは実行の途中で落ちうるので
  // （E-1・C-4）、保存したあとに再実行されると同じ記憶が2つ並ぶ。
  //
  // ここは**先に調べてから入れてよい。** ジョブは1件ずつ押さえて動く
  // （`claimNextJob`）ため、同じ返信が同時に2回処理されることは無い。
  // 外から叩かれる入口（D-12 の受信API）で同じことをしないのは、
  // **同時到着が普通に起きる**から
  const existing = await listPersonaFactsForUser(params.userId);

  if (
    existing.some(
      (fact) => fact.personaId === persona.id && fact.content === content,
    )
  ) {
    return { kind, outcome: 'ALREADY_SAVED', guided: false };
  }

  await createPersonaFactForUser(params.userId, {
    personaId: persona.id,
    factType,
    content,
    // **本人が書いたもの**。AIの推測ではない
    source: 'USER_INPUT',
    // **裏は取れていない。** 本人の申告であることと、確かめたことは別
    verification: 'UNVERIFIED',
    // **迷った `FREE_ANSWER` は一人称で使わせない**（推測を確定にしない）
    usableFirstPerson: kind !== 'FREE_ANSWER',
  });

  // **保存できたときは案内を送らない。** 送ると、返信のたびに返事が届く
  return { kind, outcome: 'SAVED', guided: false };
}
