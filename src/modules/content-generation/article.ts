/**
 * 生成された記事の検査（TASKS E-10、CONTENT_PLANNING 7.2）。
 *
 * ## プロンプトに書いただけでは守られない
 *
 * > プロンプトに明記し、**かつ受信後にコードで検査する**
 * > （CONTENT_PLANNING 7.2）
 *
 * このファイルは受信後の検査だけを持つ。**AIの申告を信じない** —
 * 「リンクは指定されたものだけ使いました」と言われても、本文から
 * 実際に抜き出して確かめる。
 *
 * DBも外部も触らない純粋な処理。
 */

import { createHash } from 'node:crypto';
import { invalidArticleError } from './errors';

/** PR表記として認める語（SPEC 15.2、景表法のステマ規制） */
export const PR_DISCLOSURE_PATTERNS: readonly RegExp[] = [
  /広告を含み/,
  /PR表記/,
  /【PR】/,
  /＃PR/,
  /#PR/,
  /アフィリエイト広告/,
  /プロモーションを含み/,
];

/** 本文から `href` を抜き出す */
export function extractHrefs(bodyHtml: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;

  for (const match of bodyHtml.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4];

    if (value !== undefined && value.trim() !== '') {
      hrefs.push(value.trim());
    }
  }

  return hrefs;
}

/**
 * URLを比べるための正規化。
 *
 * **末尾のスラッシュと大小文字の揺れを吸収する。** 揺れで別物と
 * 判定すると、正しいリンクが弾かれる。
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 本文のリンクが許されたものだけかを確かめる（CONTENT_PLANNING 7.2）。
 *
 * **許すのは内部リンクとアフィリエイトリンクだけ。** 外部サイトへの
 * リンクを自由に書かせると、意図しないサイトへ読者を送ることになり、
 * ASPの規約にも触れうる。
 *
 * `#`（ページ内アンカー）は許す — 目次からの移動に使う。
 *
 * @throws {AppError} 許されていないリンクが含まれている
 */
export function assertAllowedLinks(params: {
  bodyHtml: string;
  allowedUrls: readonly string[];
}): void {
  const allowed = new Set(params.allowedUrls.map(normalizeUrl));

  for (const href of extractHrefs(params.bodyHtml)) {
    if (href.startsWith('#')) {
      continue;
    }

    if (!allowed.has(normalizeUrl(href))) {
      throw invalidArticleError(
        `本文に許可されていないリンクがあります（${href}）`,
      );
    }
  }
}

/**
 * PR表記が入っているかを確かめる（SPEC 15.2）。
 *
 * **収益記事だけでなく、リンクを含む記事すべてに要る。** 景表法の
 * ステマ規制は「広告であること」を示すよう求めており、対象は
 * 記事の種別ではなく**広告リンクの有無**。
 *
 * @throws {AppError} PR表記が見つからない
 */
export function assertPrDisclosure(params: {
  bodyHtml: string;
  hasAffiliateLink: boolean;
}): void {
  if (!params.hasAffiliateLink) {
    return;
  }

  if (
    !PR_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(params.bodyHtml))
  ) {
    throw invalidArticleError(
      'アフィリエイトリンクを含む記事にPR表記がありません',
    );
  }
}

/**
 * 使った事実が渡した中にあるかを確かめる（CONTENT_PLANNING 7.2）。
 *
 * **知らない事実IDを申告させない。** 本文の内容そのものの検査は
 * E-12 の事実チェックだが、IDの照合はここでできる。
 *
 * @throws {AppError} 渡していない事実IDが混ざっている
 */
export function assertUsedFacts(params: {
  usedFactIds: readonly string[];
  availableFactIds: readonly string[];
}): void {
  const available = new Set(params.availableFactIds);
  const unknown = params.usedFactIds.filter((id) => !available.has(id));

  if (unknown.length > 0) {
    throw invalidArticleError(
      `渡していない事実が使われています（${unknown.length}件）`,
    );
  }
}

/**
 * 本文のハッシュ。
 *
 * **同じ内容なら同じ値。** WordPress への更新の抑止（C-5）と同じ考え方で、
 * 再生成しても中身が変わっていなければ分かる。
 */
export function articleContentHash(params: {
  title: string;
  bodyHtml: string;
}): string {
  return createHash('sha256')
    .update(`${params.title}\n${params.bodyHtml}`, 'utf8')
    .digest('hex');
}
