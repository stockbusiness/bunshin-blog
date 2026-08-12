/**
 * 本文を「読まれる形」に整える（TASKS J-1、OPEN_QUESTIONS Q-041 の (a)）。
 *
 * ## なぜ本文側で直すのか
 *
 * 記事が検索で見つかっても、**開いた先が読みにくければ読まれない。**
 * 見た目はモニターの WordPress 側（テーマ）にあるが、**本文HTMLは
 * Bunshin が作っている。** ここなら**モニターに何も頼まずに効く**し、
 * どのテーマでも同じように効く。
 *
 * **見た目を揃えない**（Q-041 の (d) を採らない理由）。30ブログが同じ
 * テーマだと、これまで避けてきた「同一運営者の痕跡」がそのまま出る。
 * **揃えるのは質だけ。**
 *
 * ## 正規表現で触る
 *
 * **本文は自分たちのAIが、自分たちのプロンプトで書いたもの**で、
 * 任意のHTMLではない（`assertNoH1` も同じ前提で正規表現を使っている）。
 * Phase 0 のために解析器を1つ増やすより、**触る範囲を狭くする**ほうを取る。
 *
 * **できないこと**：入れ子の表の見出し行、`<img>` を含むコメント、
 * 属性値の中に `>` を含むタグ。いずれもAIの出力には現れない形である。
 *
 * ## `alt` の中身は作らない
 *
 * **画像が何を写しているかは、書いた本人しか知らない。** ここで
 * それらしい文言を作ると、**読み上げに嘘が混ざる。**
 *
 * `alt` が無い画像には **空の `alt` を付ける**。空の `alt` は
 * 「読み飛ばしてよい画像」という意味で、**何も無いより正しい**
 * （何も無いと、読み上げソフトがファイル名を読む）。
 *
 * 中身のある `alt` が要るなら、**AIに書かせる**（プロンプトの仕事）。
 */

/** 目次の目印。**二度通しても増やさない**ための印でもある */
const TOC_CLASS = 'bunshin-toc';

/** 目次を出す最小の見出し数。**1つだけの目次は意味が無い** */
export const TOC_MIN_HEADINGS = 2;

/** 見出しに振るIDの前置き。**日本語をURLに入れない**（環境で壊れる） */
const HEADING_ID_PREFIX = 'midashi-';

/** `<h2 ...>中身</h2>` を拾う */
const H2_PATTERN = /<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi;

/** タグを落として、目次に出す文字だけにする */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `<h2>` に `id` を振る。
 *
 * **通し番号にする。** 見出しの文字からIDを作ると、同じ見出しが2つ
 * あるときに重複し、**目次の片方がもう片方へ飛ぶ。**
 *
 * **既に `id` があれば触らない。**
 */
export function addHeadingIds(bodyHtml: string): string {
  let index = 0;

  return bodyHtml.replace(H2_PATTERN, (match, attrs: string | undefined) => {
    index += 1;

    if (attrs !== undefined && /\sid\s*=/i.test(attrs)) {
      return match;
    }

    return match.replace(/^<h2/i, `<h2 id="${HEADING_ID_PREFIX}${index}"`);
  });
}

export interface TocEntry {
  id: string;
  text: string;
}

/**
 * `<h2>` を拾って目次の項目にする。
 *
 * **`id` を振ったあとの本文を渡すこと。**
 */
export function collectHeadings(bodyHtml: string): TocEntry[] {
  const entries: TocEntry[] = [];

  for (const match of bodyHtml.matchAll(H2_PATTERN)) {
    const attrs = match[1] ?? '';
    const id = /\sid\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const text = toPlainText(match[2] ?? '');

    // **IDも文字も無い見出しは目次に出さない**（飛べない項目になる）
    if (id === undefined || id === '' || text === '') {
      continue;
    }

    entries.push({ id, text });
  }

  return entries;
}

/**
 * 目次を組み立てる。
 *
 * **`<nav>` に入れる。** 読み上げソフトが「ここは目次だ」と分かる。
 */
export function buildTableOfContents(entries: readonly TocEntry[]): string {
  if (entries.length < TOC_MIN_HEADINGS) {
    return '';
  }

  const items = entries
    .map(
      (entry) =>
        `<li><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`,
    )
    .join('');

  return `<nav class="${TOC_CLASS}" aria-label="目次"><p class="${TOC_CLASS}-title">目次</p><ol>${items}</ol></nav>`;
}

/**
 * `alt` が無い `<img>` に空の `alt` を付ける。
 *
 * **中身は作らない**（読み上げに嘘が混ざる）。
 */
export function ensureImageAlt(bodyHtml: string): string {
  return bodyHtml.replace(
    /<img(\s[^>]*)?>/gi,
    (match, attrs: string | undefined) => {
      if (attrs !== undefined && /\salt\s*=/i.test(attrs)) {
        return match;
      }

      return match.replace(/^<img/i, '<img alt=""');
    },
  );
}

/** 表の最初の行がすべて `<td>` なら、見出し行として `<th>` にする */
function headerizeFirstRow(tableHtml: string): string {
  const firstRow = /<tr(\s[^>]*)?>([\s\S]*?)<\/tr>/i.exec(tableHtml);

  if (firstRow === null) {
    return tableHtml;
  }

  const cells = firstRow[2] ?? '';

  // **既に `<th>` があれば触らない。** 見出しの付け方は書き手のもの
  if (/<th\b/i.test(cells)) {
    return tableHtml;
  }

  if (!/<td\b/i.test(cells)) {
    return tableHtml;
  }

  const headerRow = firstRow[0]
    .replace(/<td(\s[^>]*)?>/gi, (_match, attrs: string | undefined) =>
      attrs === undefined ? '<th scope="col">' : `<th${attrs} scope="col">`,
    )
    .replace(/<\/td>/gi, '</th>');

  return tableHtml.replace(firstRow[0], headerRow);
}

/**
 * 表に見出しを付ける。
 *
 * **見出しの無い表は、読み上げると数字の羅列になる。** どの列が何なのか
 * 分からない。
 */
export function ensureTableHeaders(bodyHtml: string): string {
  return bodyHtml.replace(/<table(\s[^>]*)?>[\s\S]*?<\/table>/gi, (table) =>
    headerizeFirstRow(table),
  );
}

/**
 * 本文を読まれる形に整える。
 *
 * **目次は結論（アンサーカプセル）の後ろに置く。** 先頭に目次があると、
 * **開いた瞬間に読むものが目次になる**（SPEC 9.5 は「H1直後に結論」を
 * 求めている）。
 *
 * @param bodyHtml `composeBodyWithCapsule` を通したあとの本文
 */
export function makeBodyReadable(bodyHtml: string): string {
  // **二度通しても増やさない。** 修正依頼（F-6）の再生成では、
  // AIに前の本文を渡す。**返ってきた本文に目次が残っていることがある**
  const hasToc = new RegExp(`class="${TOC_CLASS}"`).test(bodyHtml);

  const withIds = addHeadingIds(bodyHtml);
  const withAlt = ensureImageAlt(withIds);
  const withHeaders = ensureTableHeaders(withAlt);

  const toc = hasToc ? '' : buildTableOfContents(collectHeadings(withHeaders));

  if (toc === '') {
    return withHeaders;
  }

  // **結論の直後に差し込む。** カプセルが無い本文（既に同じ文が
  // 含まれていた場合）は先頭に置く
  const capsule = /<p class="answer-capsule">[\s\S]*?<\/p>/i.exec(withHeaders);

  if (capsule === null) {
    return `${toc}${withHeaders}`;
  }

  return withHeaders.replace(capsule[0], `${capsule[0]}${toc}`);
}
