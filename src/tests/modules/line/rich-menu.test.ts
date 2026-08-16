import { describe, expect, it } from 'vitest';
import { validateRichMenu, type RichMenuInput } from '@/modules/line/rich-menu';

/**
 * リッチメニューの値の検査（Q-054）。
 *
 * **LINE に断られる前に断る。** API のエラーは英語で、
 * 何を直せばよいかを画面に出せない。
 */

function menu(overrides: Partial<RichMenuInput> = {}): RichMenuInput {
  return {
    name: 'BUNSHIN BLOG',
    chatBarText: 'メニュー',
    canvas: 'LARGE',
    selected: true,
    areas: [
      {
        x: 0,
        y: 0,
        width: 1250,
        height: 843,
        label: 'はじめの設定',
        uri: 'https://liff.line.me/1-a/liff/onboarding',
      },
    ],
    ...overrides,
  };
}

describe('通るもの', () => {
  it('枠に収まっていれば通る', () => {
    expect(() => {
      validateRichMenu(menu());
    }).not.toThrow();
  });

  /** 押す場所が無い下書きは保存できる。**適用のときに止める** */
  it('押す場所が無くても保存はできる', () => {
    expect(() => {
      validateRichMenu(menu({ areas: [] }));
    }).not.toThrow();
  });
});

describe('LINE の決まりで断る', () => {
  /** **14字を超えると LINE が断る** */
  it('メニューバーの文字が長すぎる', () => {
    expect(() => {
      validateRichMenu({ ...menu(), chatBarText: 'あ'.repeat(15) });
    }).toThrow(/14字/);
  });

  it('メニューバーの文字が空', () => {
    expect(() => {
      validateRichMenu({ ...menu(), chatBarText: '  ' });
    }).toThrow(/メニューバーの文字/);
  });

  it('名前が空', () => {
    expect(() => {
      validateRichMenu({ ...menu(), name: '' });
    }).toThrow(/名前/);
  });
});

describe('押す場所を確かめる', () => {
  it('枠からはみ出したら断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 2000,
              y: 0,
              width: 1000,
              height: 843,
              label: 'はみ出す',
              uri: 'https://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/はみ出して/);
  });

  /** 細い枠は高さ 843。**枠を変えたら入らなくなる場所がある** */
  it('細い枠では高さも見る', () => {
    expect(() => {
      validateRichMenu(menu({ canvas: 'COMPACT' }));
    }).not.toThrow();

    expect(() => {
      validateRichMenu({
        ...menu({ canvas: 'COMPACT' }),
        areas: [
          {
            x: 0,
            y: 0,
            width: 1250,
            height: 1686,
            label: '高すぎる',
            uri: 'https://example.com/',
          },
        ],
      });
    }).toThrow(/はみ出して/);
  });

  /** **重なると、どちらが押されたか決まらない** */
  it('重なっていたら断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: '左',
              uri: 'https://example.com/a',
            },
            {
              x: 1000,
              y: 0,
              width: 1250,
              height: 843,
              label: '右',
              uri: 'https://example.com/b',
            },
          ],
        }),
      );
    }).toThrow(/重なって/);
  });

  it('辺が接しているだけなら通す', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: '左',
              uri: 'https://example.com/a',
            },
            {
              x: 1250,
              y: 0,
              width: 1250,
              height: 843,
              label: '右',
              uri: 'https://example.com/b',
            },
          ],
        }),
      );
    }).not.toThrow();
  });

  it('大きさが0なら断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 0,
              height: 843,
              label: '幅なし',
              uri: 'https://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/位置と大きさ/);
  });

  it('小数は断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0.5,
              y: 0,
              width: 1250,
              height: 843,
              label: '小数',
              uri: 'https://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/位置と大きさ/);
  });
});

/** **https だけ。** この実験に他の宛先は要らない */
describe('行き先を確かめる', () => {
  it('http は断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: 'だめ',
              uri: 'http://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/https/);
  });

  it('URLでない文字列は断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: 'だめ',
              uri: 'おんなじ',
            },
          ],
        }),
      );
    }).toThrow(/https/);
  });

  it('名前が空なら断る', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: '',
              uri: 'https://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/名前/);
  });

  /** **何つ目かを言う。** 6個並ぶので「どれか」が分からないと直せない */
  it('何つ目かを言う', () => {
    expect(() => {
      validateRichMenu(
        menu({
          areas: [
            {
              x: 0,
              y: 0,
              width: 1250,
              height: 843,
              label: 'よい',
              uri: 'https://example.com/',
            },
            {
              x: 1250,
              y: 0,
              width: 1250,
              height: 843,
              label: 'わるい',
              uri: 'http://example.com/',
            },
          ],
        }),
      );
    }).toThrow(/2つ目/);
  });
});
