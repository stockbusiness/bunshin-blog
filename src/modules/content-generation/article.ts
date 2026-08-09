/**
 * 生成された記事の検査（TASKS E-10、CONTENT_PLANNING 7.2）。
 *
 * ## プロンプトに書いただけでは守られない
 *
 * > プロンプトに明記し、**かつ受信後にコードで検査する**
 * > （CONTENT_PLANNING 7.2）
 *
 * このファイルは受信後の検査と、**AIに任せない組み立て**（アンサーカプセルを
 * H1直後に置く。E-11）を持つ。**AIの申告を信じない** —
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
 * アンサーカプセルの文字数（SPEC 9.5、CONTENT_PLANNING 7.2）。
 *
 * **範囲外なら再生成する** — 落として終わりにしない。短すぎる結論は
 * 検索結果で意味を成さず、長すぎると「H1直後の結論」ではなくなる。
 */
export const ANSWER_CAPSULE_MIN_LENGTH = 80;
export const ANSWER_CAPSULE_MAX_LENGTH = 120;

/**
 * 文字数を数える。
 *
 * **`String.length` を使わない。** UTF-16 のコード単位を数えるため、
 * 絵文字や一部の漢字が2文字に見え、80字の結論が「120字を超えた」と
 * 判定されうる。
 */
export function countCharacters(text: string): number {
  return [...text.trim()].length;
}

/**
 * アンサーカプセルの長さを確かめる（CONTENT_PLANNING 7.2）。
 *
 * @throws {AppError} 80〜120字の範囲外
 */
export function assertAnswerCapsule(answerCapsule: string): void {
  const length = countCharacters(answerCapsule);

  if (
    length < ANSWER_CAPSULE_MIN_LENGTH ||
    length > ANSWER_CAPSULE_MAX_LENGTH
  ) {
    throw invalidArticleError(
      `アンサーカプセルは${ANSWER_CAPSULE_MIN_LENGTH}〜${ANSWER_CAPSULE_MAX_LENGTH}字にしてください（${length}字）`,
    );
  }
}

/** FAQ の件数（SPEC 9.5「3〜5問」） */
export const FAQ_MIN_COUNT = 3;
export const FAQ_MAX_COUNT = 5;

/** 疑問符として認める文字（全角・半角） */
const QUESTION_MARKS = ['？', '?'];

/**
 * FAQ の件数と形を確かめる（SPEC 9.5、CONTENT_PLANNING 7.2）。
 *
 * **見出しを疑問形にする。** JSON-LD の `Question` になるため、
 * 疑問形でない見出しはそのまま検索結果に出てしまう。
 *
 * @throws {AppError} 件数が範囲外、または疑問符で終わらない見出しがある
 */
export function assertFaq(
  faq: readonly { question: string; answer: string }[],
): void {
  if (faq.length < FAQ_MIN_COUNT || faq.length > FAQ_MAX_COUNT) {
    throw invalidArticleError(
      `FAQ は${FAQ_MIN_COUNT}〜${FAQ_MAX_COUNT}件にしてください（${faq.length}件）`,
    );
  }

  for (const entry of faq) {
    const question = entry.question.trim();

    if (!QUESTION_MARKS.some((mark) => question.endsWith(mark))) {
      throw invalidArticleError(
        `FAQ の見出しは疑問形にしてください（${question}）`,
      );
    }
  }
}

/**
 * 本文に `<h1>` が無いことを確かめる。
 *
 * **H1は記事タイトルが担う。** WordPress はタイトルを H1 として描画する
 * （C-4 の投稿は `title` を別に渡す）。本文にもう1つ H1 があると
 * 見出し構造が崩れ、**結論が「H1直後」ではなくなる**。
 *
 * @throws {AppError} 本文に `<h1>` がある
 */
export function assertNoH1(bodyHtml: string): void {
  if (/<h1\b/i.test(bodyHtml)) {
    throw invalidArticleError(
      '本文に h1 を書かないでください（h1 は記事タイトルです）',
    );
  }
}

/**
 * アンサーカプセルを本文の先頭に置く（TASKS E-11 の完了条件）。
 *
 * **置く位置をAIに任せない。** タイトルが H1 として描画されるので、
 * 本文の先頭＝H1直後。`assertNoH1` と組で「H1直後に結論がある」ことを
 * コードで保証する。
 *
 * 既に本文の中にカプセルと同じ文が含まれている場合は**足さない** —
 * 同じ結論が二度並ぶ記事になるため。
 */
export function composeBodyWithCapsule(params: {
  answerCapsule: string;
  bodyHtml: string;
}): string {
  const capsule = params.answerCapsule.trim();

  if (params.bodyHtml.includes(capsule)) {
    return params.bodyHtml;
  }

  return `<p class="answer-capsule">${escapeHtml(capsule)}</p>${params.bodyHtml}`;
}

/**
 * カプセルを本文へ埋め込むための最小限のエスケープ。
 *
 * **カプセルはAIの出力。** HTMLとして解釈させるとタグを混ぜられる。
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
