import { describe, expect, it } from 'vitest';
import { REPLY_KINDS, classifyLineReply } from '@/modules/line';
import { FACT_TYPES } from '@/modules/personas';

/**
 * LINE返信の分類（TASKS D-7a、SPEC 8.4、Q-015）。
 *
 * **見ているのは「どこへ入れるか」だけ。** 内容の良し悪しは判定しない。
 */

describe('種類', () => {
  it('SPEC 8.4 の4種類', () => {
    expect([...REPLY_KINDS]).toEqual([
      'PRODUCT_REVIEW',
      'ADVICE',
      'FREE_ANSWER',
      'REVISION_REQUEST',
    ]);
  });

  /** `persona_facts.fact_type` に入らない値を返すと、保存時に落ちる */
  it('返す factType は persona_facts の種類のいずれか', () => {
    const texts = [
      '先月から使ってみました',
      '初心者は気をつけたほうがいい',
      'はい',
      'タイトルを直してください',
    ];

    for (const text of texts) {
      const { factType } = classifyLineReply(text);

      if (factType !== null) {
        expect(FACT_TYPES).toContain(factType);
      }
    }
  });
});

describe('商品の感想', () => {
  it.each([
    '先月から使ってみました。思ったより軽いです',
    '実際に買ったので言えますが、届くまで3日かかりました',
    '2年契約したけど解約は簡単でした',
  ])('%s → PRODUCT_REVIEW', (text) => {
    expect(classifyLineReply(text)).toEqual({
      kind: 'PRODUCT_REVIEW',
      factType: 'PRODUCT_REVIEW',
    });
  });
});

describe('初心者への助言', () => {
  it.each([
    '初心者はまず無料版から試すのがおすすめです',
    '申込前に解約条件を見たほうが良いので注意してください',
  ])('%s → ADVICE', (text) => {
    expect(classifyLineReply(text)).toEqual({
      kind: 'ADVICE',
      factType: 'OPINION',
    });
  });
});

/**
 * **迷ったら粗いほうへ。** 感想と決めつけて `PRODUCT_REVIEW` に入れると、
 * 使ってもいない商品の体験談として記事に出る
 */
describe('自由回答', () => {
  it.each([
    { name: '短い返事', text: 'はい' },
    { name: '語が一つも当たらない', text: '今週は忙しかったです' },
    { name: '空文字', text: '' },
    { name: '空白だけ', text: '  \n ' },
  ])('$name → FREE_ANSWER', ({ text }) => {
    expect(classifyLineReply(text)).toEqual({
      kind: 'FREE_ANSWER',
      factType: 'OPINION',
    });
  });
});

describe('修正希望', () => {
  it.each([
    'タイトルを直してください',
    'この記事は短くしてほしい',
    '価格が間違っています',
    '3つ目の見出しを削除してください',
  ])('%s → REVISION_REQUEST', (text) => {
    expect(classifyLineReply(text)).toEqual({
      kind: 'REVISION_REQUEST',
      factType: null,
    });
  });

  /**
   * **保存しない。** `revision_requests.approval_id` は NOT NULL だが、
   * LINEのテキスト返信には**どの記事への返信かを示す情報が無い。**
   * 直近の承認に紐づけると、**違う記事が書き換わる**（F-6 の画面へ案内する）
   */
  it('factType は null', () => {
    expect(classifyLineReply('書き直してください').factType).toBeNull();
  });

  /**
   * **両方の語が入ったら修正希望。**
   * 修正希望を感想として保存すると、モニターの「直して」が
   * **記事の素材として使われる。** 逆向きの取り違えは案内が1つ増えるだけ
   */
  it('感想の語と混ざっていても修正希望が勝つ', () => {
    expect(
      classifyLineReply('使ってみた感想は合っていますが、短くして'),
    ).toEqual({ kind: 'REVISION_REQUEST', factType: null });
  });

  it('助言の語と混ざっていても修正希望が勝つ', () => {
    expect(classifyLineReply('初心者向けの部分を書き直してください')).toEqual({
      kind: 'REVISION_REQUEST',
      factType: null,
    });
  });
});

/**
 * **取り違えたときの害が大きいほうを先に見る**（修正希望 → 助言 → 感想）。
 * 語が複数当たる返信は珍しくない
 */
describe('語が複数当たったとき', () => {
  /**
   * **「解約」だけで感想にしない。** 済んだことを示す語（`解約した`）と、
   * 助言に出てくる名詞（`解約条件`）は別物
   */
  it('済んでいない「解約」は感想にならない', () => {
    expect(classifyLineReply('申込前に解約条件を確認してください').kind).toBe(
      'FREE_ANSWER',
    );
  });

  /** 使ってもいない商品の体験談を作らない */
  it('助言が感想より先', () => {
    expect(
      classifyLineReply('解約したときの話ですが、初心者は注意です'),
    ).toEqual({ kind: 'ADVICE', factType: 'OPINION' });
  });
});

/** 同じ返信を2回受け取ったとき（再送・再実行）に種類が変わらない */
describe('決まり方', () => {
  it('同じ文字列は何度でも同じ結果', () => {
    const text = '先月から使ってみました';

    expect(classifyLineReply(text)).toEqual(classifyLineReply(text));
  });

  it('前後の空白で結果が変わらない', () => {
    expect(classifyLineReply('  購入しました  ')).toEqual(
      classifyLineReply('購入しました'),
    );
  });
});
