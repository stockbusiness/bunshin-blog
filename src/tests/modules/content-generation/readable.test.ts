import { describe, expect, it } from 'vitest';
import {
  addHeadingIds,
  buildTableOfContents,
  collectHeadings,
  ensureImageAlt,
  ensureTableHeaders,
  makeBodyReadable,
} from '@/modules/content-generation';

/**
 * 本文を読まれる形に整える（TASKS J-1、Q-041 の (a)）。
 *
 * **本文HTMLは Bunshin が作っている**ので、ここで直せば
 * **モニターに何も頼まずに、どのテーマでも効く。**
 */

const CAPSULE = '<p class="answer-capsule">結論です。</p>';

describe('見出しに id を振る', () => {
  it('通し番号で振る', () => {
    const html = addHeadingIds('<h2>あ</h2><p>x</p><h2>い</h2>');

    expect(html).toContain('<h2 id="midashi-1">あ</h2>');
    expect(html).toContain('<h2 id="midashi-2">い</h2>');
  });

  /**
   * **見出しの文字からIDを作らない。** 同じ見出しが2つあると重複し、
   * **目次の片方がもう片方へ飛ぶ**
   */
  it('同じ見出しが並んでも別のIDになる', () => {
    const html = addHeadingIds('<h2>まとめ</h2><h2>まとめ</h2>');

    expect(html).toContain('id="midashi-1"');
    expect(html).toContain('id="midashi-2"');
  });

  it('既に id があれば触らない', () => {
    expect(addHeadingIds('<h2 id="keep">あ</h2>')).toBe(
      '<h2 id="keep">あ</h2>',
    );
  });

  it('h3 には振らない', () => {
    expect(addHeadingIds('<h3>あ</h3>')).toBe('<h3>あ</h3>');
  });
});

describe('目次', () => {
  it('見出しから項目を作る', () => {
    const entries = collectHeadings(addHeadingIds('<h2>あ</h2><h2>い</h2>'));

    expect(entries).toEqual([
      { id: 'midashi-1', text: 'あ' },
      { id: 'midashi-2', text: 'い' },
    ]);
  });

  /** 見出しの中の装飾タグは落とす（目次に `<strong>` を出さない） */
  it('見出しの中のタグを落とす', () => {
    const entries = collectHeadings(
      addHeadingIds('<h2><strong>強い</strong>見出し</h2><h2>い</h2>'),
    );

    expect(entries[0]?.text).toBe('強い見出し');
  });

  /** **1つだけの目次は意味が無い** */
  it('見出しが1つなら出さない', () => {
    expect(buildTableOfContents([{ id: 'a', text: 'あ' }])).toBe('');
  });

  it('読み上げソフトに目次だと分かる形にする', () => {
    const toc = buildTableOfContents([
      { id: 'a', text: 'あ' },
      { id: 'b', text: 'い' },
    ]);

    expect(toc).toContain('<nav');
    expect(toc).toContain('aria-label="目次"');
    expect(toc).toContain('<a href="#a">あ</a>');
  });

  /** **見出しはAIの出力。** そのまま入れるとタグを混ぜられる */
  it('見出しの文字をエスケープする', () => {
    const toc = buildTableOfContents([
      { id: 'a', text: '<script>x</script>' },
      { id: 'b', text: 'い' },
    ]);

    expect(toc).not.toContain('<script>');
    expect(toc).toContain('&lt;script&gt;');
  });
});

/**
 * **中身は作らない。** 画像が何を写しているかは書いた本人しか知らず、
 * それらしい文言を作ると**読み上げに嘘が混ざる**
 */
describe('画像の alt', () => {
  it('無ければ空の alt を付ける', () => {
    expect(ensureImageAlt('<img src="a.png">')).toBe(
      '<img alt="" src="a.png">',
    );
  });

  it('あれば触らない', () => {
    expect(ensureImageAlt('<img src="a.png" alt="図">')).toBe(
      '<img src="a.png" alt="図">',
    );
  });

  it('複数あってもすべて付ける', () => {
    const html = ensureImageAlt('<img src="a.png"><img src="b.png" alt="い">');

    expect(html).toBe('<img alt="" src="a.png"><img src="b.png" alt="い">');
  });
});

/**
 * **見出しの無い表は、読み上げると数字の羅列になる。**
 * どの列が何なのか分からない
 */
describe('表の見出し', () => {
  it('最初の行を見出しにする', () => {
    const html = ensureTableHeaders(
      '<table><tr><td>項目</td><td>値</td></tr><tr><td>料金</td><td>500円</td></tr></table>',
    );

    expect(html).toContain('<th scope="col">項目</th>');
    expect(html).toContain('<th scope="col">値</th>');
    // **2行目は本文のまま**
    expect(html).toContain('<td>料金</td>');
  });

  /** **見出しの付け方は書き手のもの** */
  it('既に th があれば触らない', () => {
    const original =
      '<table><tr><th>項目</th></tr><tr><td>料金</td></tr></table>';

    expect(ensureTableHeaders(original)).toBe(original);
  });

  it('表が無ければ何もしない', () => {
    expect(ensureTableHeaders('<p>本文</p>')).toBe('<p>本文</p>');
  });
});

describe('まとめて整える', () => {
  /**
   * **目次は結論の後ろ。** 先頭に置くと、**開いた瞬間に読むものが
   * 目次になる**（SPEC 9.5 は「H1直後に結論」を求めている）
   */
  it('目次を結論の後ろに置く', () => {
    const html = makeBodyReadable(`${CAPSULE}<h2>あ</h2><h2>い</h2>`);

    expect(html.indexOf(CAPSULE)).toBeLessThan(html.indexOf('bunshin-toc'));
    expect(html.indexOf('bunshin-toc')).toBeLessThan(html.indexOf('<h2'));
  });

  it('結論が無ければ先頭に置く', () => {
    const html = makeBodyReadable('<h2>あ</h2><h2>い</h2>');

    expect(html.startsWith('<nav')).toBe(true);
  });

  it('見出しが1つなら目次を足さない', () => {
    const html = makeBodyReadable(`${CAPSULE}<h2>あ</h2>`);

    expect(html).not.toContain('bunshin-toc');
    // 見出しのIDは振る（後から目次を出せるように）
    expect(html).toContain('id="midashi-1"');
  });

  it('目次から見出しへ飛べる', () => {
    const html = makeBodyReadable('<h2>あ</h2><h2>い</h2>');

    expect(html).toContain('href="#midashi-1"');
    expect(html).toContain('<h2 id="midashi-1">');
  });

  /** **二度通しても増えない**（再生成で本文を通し直しても同じ形） */
  it('二度通しても目次が二重にならない', () => {
    const once = makeBodyReadable(`${CAPSULE}<h2>あ</h2><h2>い</h2>`);
    const twice = makeBodyReadable(once);

    expect(twice.match(/bunshin-toc"/g)).toHaveLength(1);
  });
});
