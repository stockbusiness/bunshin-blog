/**
 * LINE返信の分類（TASKS D-7、SPEC 8.4、OPEN_QUESTIONS Q-015）。
 *
 * DBも外部も触らない純粋な処理。
 *
 * ## 何を分けるのか
 *
 * SPEC 8.4 が扱うのは4種類。
 *
 * | 返信 | 行き先 |
 * |---|---|
 * | 商品の感想 | `persona_facts`（`PRODUCT_REVIEW`） |
 * | 初心者への助言 | `persona_facts`（`OPINION`） |
 * | 簡単な自由回答 | `persona_facts`（`OPINION`） |
 * | 修正希望 | **保存しない**（宛先が決まらない・下記） |
 *
 * ## 修正希望を保存しない理由
 *
 * `revision_requests.approval_id` は NOT NULL で、**どの承認への修正依頼か**を
 * 必ず持つ。ところが **LINEのテキスト返信には、どの記事への返信かを示す
 * 情報が無い。**
 *
 * 直近の未回答の承認に紐づけることもできるが、**違う記事への修正依頼が
 * 別の記事に付く**。修正依頼は記事を書き換える指示なので、
 * 取り違えると**望んでいない書き換えが起きる。**
 *
 * ここでは**分類だけを返し、保存しない。** 呼び出し側が承認画面（F-6）へ
 * 案内する。
 *
 * ## AIに判定させない
 *
 * **語で見分ける。** 記事の内容を決める判断ではなく、
 * 「どこへ入れるか」の振り分けなので、外部呼び出しの費用と失敗を
 * 持ち込む理由が無い。
 *
 * **迷ったら `FREE_ANSWER`。** 感想と決めつけて `PRODUCT_REVIEW` に
 * 入れるより、種類が粗いほうが後から直せる（**推測を確定として保存しない**）。
 *
 * ## 語が複数当たったときの順番
 *
 * 見る順は **修正希望 → 助言 → 感想 → 自由回答。**
 * 「解約するときは注意」のように複数の語が当たる返信は珍しくないので、
 * **取り違えたときの害が大きいほうを先に見る。**
 *
 * | 取り違え | 起きること |
 * |---|---|
 * | 修正希望を感想として保存 | モニターの「直して」が**記事の素材になる** |
 * | 助言を感想として保存 | **使ってもいない商品の体験談**が記事に出る |
 * | 感想を助言として保存 | `OPINION` に入る。**主張が弱いほうへ倒れるだけ** |
 */

import type { FactType } from '@/modules/personas';

export const REPLY_KINDS = [
  'PRODUCT_REVIEW',
  'ADVICE',
  'FREE_ANSWER',
  'REVISION_REQUEST',
] as const;

export type ReplyKind = (typeof REPLY_KINDS)[number];

export interface ReplyClassification {
  kind: ReplyKind;
  /** `persona_facts` に入れるときの種類。**保存しないものは `null`** */
  factType: FactType | null;
}

/**
 * 修正を求める語。
 *
 * **ここだけは広めに拾う。** 修正希望を感想として保存すると、
 * **モニターの「直して」が記事の素材として使われる。**
 * 逆に感想を修正希望と見なしても、案内が1つ増えるだけで害が小さい。
 */
const REVISION_WORDS = [
  '修正',
  '直し',
  '直す',
  '直して',
  '変えて',
  '書き直',
  '短く',
  '長く',
  'やめて',
  '削除',
  '消して',
  '差し替え',
  'タイトルを',
  '間違',
  '誤り',
];

/**
 * 使った・買った、という**自分の経験**を示す語。
 *
 * **「購入」「解約」のような名詞では拾わない。** 「解約条件に注意」のような
 * 助言にも同じ語が出るため、**済んだこと**を示す形だけを見る。
 */
const PRODUCT_REVIEW_WORDS = [
  '使ってみ',
  '使った',
  '使っています',
  '買った',
  '買いました',
  '購入し',
  '試した',
  '試してみ',
  '契約し',
  '解約し',
  '届いた',
];

/** 人に勧める・注意を促す語 */
const ADVICE_WORDS = [
  '初心者',
  'はじめての',
  '初めての',
  'おすすめ',
  'お勧め',
  '注意',
  '気をつけ',
  'したほうがいい',
  'したほうが良い',
  'ほうが安全',
  'コツ',
];

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

/**
 * 返信を分類する。
 *
 * **空文字は `FREE_ANSWER`。** 呼び出し側が「保存する内容が無い」ことを
 * 別に判断する（ここで例外にすると、分類のためだけに try が要る）。
 */
export function classifyLineReply(text: string): ReplyClassification {
  const normalized = text.trim();

  // **修正希望を最初に見る。** 「使ってみたけど短くして」のように
  // 両方の語が入る返信は、**修正希望として扱う**（取り違えの害が大きいほう）
  if (includesAny(normalized, REVISION_WORDS)) {
    return { kind: 'REVISION_REQUEST', factType: null };
  }

  // **助言を感想より先に見る。** 「解約するときは注意」のように両方の語が
  // 入る返信を `PRODUCT_REVIEW` に入れると、**使ってもいない商品の体験談**
  // として記事に出る。逆に体験談を `OPINION` として持っても、
  // **主張が弱いほうへ倒れるだけ**で嘘にはならない
  if (includesAny(normalized, ADVICE_WORDS)) {
    return { kind: 'ADVICE', factType: 'OPINION' };
  }

  if (includesAny(normalized, PRODUCT_REVIEW_WORDS)) {
    return { kind: 'PRODUCT_REVIEW', factType: 'PRODUCT_REVIEW' };
  }

  // **迷ったら粗いほうへ。** 推測を確定として保存しない
  return { kind: 'FREE_ANSWER', factType: 'OPINION' };
}
