import type { RiskFlag } from './risk-flags';

/**
 * 記事の「厚み」を測る（TASKS J-4）。
 *
 * ## なぜ要るのか
 *
 * 事実チェック（E-12）は**嘘**を止め、禁止表現の検査（E-13）は
 * **言ってはいけないこと**を止める。**「薄い」を止めるものが無かった。**
 *
 * 90日検証で出るのは 300〜600 記事。**全部が薄ければ成果はゼロ**である。
 * 読まれる形に整えても（J-1）、中身が無ければ読まれない。
 *
 * ## 新しいデータを取らない
 *
 * **すでに保存しているもので測れる。**
 *
 * | 見るもの | どこにあるか |
 * |---|---|
 * | 案件の事実をいくつ使ったか | `article_versions.used_fact_ids` |
 * | 見出しの数・本文の長さ | `body_html` |
 * | 収益記事への誘導 | `content_items.outbound_link_item_ids` |
 *
 * **`used_fact_ids` は保存しているのに、誰も読んでいなかった。**
 * 案件の事実を1つも使わずに書かれた記事は、**その案件について
 * 具体的なことを何も言っていない**ということである。
 *
 * ## 止めない。見えるようにする
 *
 * **すべて `warning` にする。** `error` にすると承認へ送れなくなるが、
 * **記事を作り直す経路がまだ無い**（`ARTICLE_REGENERATION` は種類が
 * あるだけで、誰も積んでいない）。止めた記事は**二度と出られない。**
 *
 * **黙って出力が減るほうが、薄い記事が出るより悪い。** 承認者に見せて、
 * 判断を残す（SPEC 1.1「LINE承認型」）。作り直す経路ができたら、
 * そのとき止めるかを決め直す（`OPEN_QUESTIONS` Q-042）。
 */

/**
 * 本文の最小の文字数（タグを除く）。
 *
 * **1200字。** SPEC 9.5 が求める構成（結論・見出し・FAQ 3〜5問）を
 * 満たすと自然に超える。**下回るのは、構成があっても中身が無いとき。**
 */
export const MIN_BODY_CHARS = 1200;

/** 見出しの最小数。**2つ以下は「章立てが無い」** */
export const MIN_HEADINGS = 3;

export interface ThicknessInput {
  /** 整えたあとの本文（J-1 を通したもの） */
  bodyHtml: string;
  /** 記事が使った事実のID（`article_versions.used_fact_ids`） */
  usedFactIds: readonly string[];
  /**
   * この記事に案件が紐づいているか。
   *
   * **案件の無い記事に「事実を使っていない」と言わない。**
   * 使う相手がいない。
   */
  hasOffer: boolean;
  /** 構成表が定めた誘導先の数（`outbound_link_item_ids`） */
  plannedOutboundLinks: number;
  /** 本文に実際に置かれた内部リンクの数 */
  actualInternalLinks: number;
}

/** タグを落として、読者が読む文字だけを数える */
export function countBodyChars(bodyHtml: string): number {
  return bodyHtml
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, '').length;
}

/** `<h2>` と `<h3>` を数える */
export function countHeadings(bodyHtml: string): number {
  return (bodyHtml.match(/<h[23]\b/gi) ?? []).length;
}

/**
 * 厚みを測って、足りないところをフラグにする。
 *
 * **止めない**（すべて `warning`）。理由はファイル冒頭。
 */
export function judgeThickness(input: ThicknessInput): RiskFlag[] {
  const flags: RiskFlag[] = [];

  const chars = countBodyChars(input.bodyHtml);

  if (chars < MIN_BODY_CHARS) {
    flags.push({
      code: 'THIN_BODY',
      severity: 'warning',
      message: `本文が${MIN_BODY_CHARS}字に届いていません（${chars}字）`,
      excerpt: '',
    });
  }

  const headings = countHeadings(input.bodyHtml);

  if (headings < MIN_HEADINGS) {
    flags.push({
      code: 'FEW_HEADINGS',
      severity: 'warning',
      message: `見出しが${MIN_HEADINGS}つに届いていません（${headings}つ）`,
      excerpt: '',
    });
  }

  // **案件が紐づいているときだけ見る**
  if (input.hasOffer && input.usedFactIds.length === 0) {
    flags.push({
      code: 'NO_FACT_USED',
      severity: 'warning',
      // **原因を1つに決めつけない。** 案件に事実が登録されていない
      // 場合もある（D-13）。どちらでも、確かめるのは承認者
      message:
        '案件の事実を1つも使っていません（案件に事実が登録されていない可能性もあります）',
      excerpt: '',
    });
  }

  // **構成表が誘導先を定めているのに、本文にリンクが無い**
  if (input.plannedOutboundLinks > 0 && input.actualInternalLinks === 0) {
    flags.push({
      code: 'NO_INTERNAL_LINK',
      severity: 'warning',
      message: '収益記事への内部リンクが本文にありません',
      excerpt: '',
    });
  }

  return flags;
}
