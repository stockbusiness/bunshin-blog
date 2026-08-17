import { describe, expect, it } from 'vitest';
import { readApiErrorMessage } from '@/lib/api-error';
import { toErrorResponse } from '@/lib/errors';
import { AppError } from '@/lib/errors';

/**
 * APIの失敗の理由を画面へ出す（2026-08-17 に見つけた不具合）。
 *
 * ## 何が起きていたか
 *
 * サーバーが返す形は `{ error: { message } }` の1つだけなのに、
 * **画面側で `body.message` と読んでいた場所が6つあった。**
 * その形は存在しないので、**サーバーが理由を説明しているのに
 * 画面には決まり文句しか出なかった。**
 *
 * `/admin/rich-menu` が「うまくいきませんでした」しか出さず、
 * **何が起きているのか画面からは分からなかった。**
 *
 * ここで確かめるのは2つ。
 *
 * 1. **サーバーが実際に返す形から取り出せる**（形を想像で書かない）
 * 2. **取り出せないときだけ決まり文句にする**
 */

describe('サーバーが返す形から取り出す', () => {
  /**
   * **想像した形ではなく、実際の出力を通す。**
   * ここを固定の JSON にすると、サーバー側が形を変えたときに気づけない
   * （Q-051 で「こちらの思い込みを確かめていた」と同じ間違いになる）。
   */
  it('AppError の応答から理由を取り出す', () => {
    const { body } = toErrorResponse(
      AppError.validationFailed('入力を確かめてください'),
    );

    expect(readApiErrorMessage(body, '決まり文句')).toBe(
      '入力を確かめてください',
    );
  });

  it('500 でも理由を取り出す', () => {
    const { body } = toErrorResponse(
      new AppError('BOOM', 500, 'テーブルがありません'),
    );

    expect(readApiErrorMessage(body, '決まり文句')).toBe(
      'テーブルがありません',
    );
  });
});

describe('取り出せないとき', () => {
  it.each([
    ['null', null],
    ['文字列', 'こわれた'],
    ['空のオブジェクト', {}],
    ['error が無い', { message: '外側にある' }],
    ['error が文字列', { error: 'こわれた' }],
    ['message が無い', { error: { code: 'X' } }],
    ['message が数値', { error: { message: 500 } }],
  ])('%s なら決まり文句', (_name, body) => {
    expect(readApiErrorMessage(body, '決まり文句')).toBe('決まり文句');
  });

  /** **空の吹き出しを出さない。** 何も起きていないように見える */
  it('空文字なら決まり文句', () => {
    expect(readApiErrorMessage({ error: { message: '' } }, '決まり文句')).toBe(
      '決まり文句',
    );
  });

  /**
   * **外側の `message` を拾わない。** 拾うと、いま直した不具合が
   * 「動いているように見えるまま」戻る
   */
  it('外側の message は使わない', () => {
    expect(
      readApiErrorMessage({ message: 'これは使わない' }, '決まり文句'),
    ).toBe('決まり文句');
  });
});
