/**
 * JSON-LD の組み立て（TASKS E-11、CONTENT_PLANNING 7.3）。
 *
 * ## AIに生成させない
 *
 * > **AIに生成させない。** `faq` と記事種別から**コードで組み立てる**
 * > （CONTENT_PLANNING 7.3）
 *
 * 構造化データは検索エンジンに対する**機械可読な申告**で、内容が本文と
 * 食い違うとスパム扱いされうる。だから元になるのは、既にコードの検査を
 * 通った `faq` とアンサーカプセルだけにする。
 *
 * ## 組み立てたら構文を確かめる
 *
 * > 生成後に `JSON.parse` で構文を検証し、失敗したら記事を
 * > `READY_FOR_REVIEW` にせずジョブを失敗させる（CONTENT_PLANNING 7.3）
 *
 * DBも外部も触らない純粋な処理。
 */

import { invalidStructuredDataError } from './errors';

export interface StructuredDataFaq {
  question: string;
  answer: string;
}

export interface BuildStructuredDataInput {
  contentType: string;
  faq: readonly StructuredDataFaq[];
  answerCapsule: string;
  /** 収益記事（`AFFILIATE`）の案件名。`Review.itemReviewed` になる */
  offerName: string | null;
  /** 分身のペンネーム。`Review.author` になる */
  authorName: string | null;
}

/**
 * JSONで表せる値。
 *
 * **`unknown` にしない。** JSON-LD はそのまま `jsonb` に入り、
 * `JSON.stringify` を通る。`undefined` や関数を型で弾いておく。
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-LD の1ブロック */
export type JsonLdBlock = { [key: string]: JsonValue };

const SCHEMA_CONTEXT = 'https://schema.org';

function buildFaqPage(faq: readonly StructuredDataFaq[]): JsonLdBlock {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'FAQPage',
    mainEntity: faq.map((entry) => ({
      '@type': 'Question',
      name: entry.question.trim(),
      acceptedAnswer: {
        '@type': 'Answer',
        text: entry.answer.trim(),
      },
    })),
  };
}

/**
 * `Review` を組み立てる。
 *
 * **`reviewRating` を入れない。** 評点の出どころが無いためで、
 * ここで適当な数字を入れると「根拠のないランキング」（SPEC 9.6 の禁止事項）
 * と同じことになる。Google の Review 構造化データは `reviewRating` を
 * 必須としているため、**このままではリッチリザルトの対象にならない** —
 * どう扱うかは Q-021 で未解決。
 */
function buildReview(params: {
  offerName: string;
  authorName: string | null;
  answerCapsule: string;
}): JsonLdBlock {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Review',
    itemReviewed: {
      '@type': 'Product',
      name: params.offerName,
    },
    reviewBody: params.answerCapsule.trim(),
    ...(params.authorName === null
      ? {}
      : { author: { '@type': 'Person', name: params.authorName } }),
  };
}

/**
 * 記事種別と FAQ から JSON-LD を組み立てる（CONTENT_PLANNING 7.3）。
 *
 * ```ts
 * // contentType === "AFFILIATE" → FAQPage + Review
 * // それ以外 → FAQPage
 * ```
 *
 * @throws {AppError} 組み立てに必要な材料が足りない
 */
export function buildStructuredData(
  input: BuildStructuredDataInput,
): JsonLdBlock[] {
  if (input.faq.length === 0) {
    throw invalidStructuredDataError('FAQ が空です');
  }

  const blocks: JsonLdBlock[] = [buildFaqPage(input.faq)];

  if (input.contentType === 'AFFILIATE') {
    // **黙って Review を省かない。** 収益記事に案件が紐づいていないのは
    // 構成表の側の異常で、ここで見なかったことにすると原因が消える
    if (input.offerName === null || input.offerName.trim() === '') {
      throw invalidStructuredDataError(
        '収益記事に案件が紐づいていません（Review を組み立てられません）',
      );
    }

    blocks.push(
      buildReview({
        offerName: input.offerName.trim(),
        authorName: input.authorName,
        answerCapsule: input.answerCapsule,
      }),
    );
  }

  assertValidJsonLd(blocks);

  return blocks;
}

/**
 * 組み立てた JSON-LD が構文的に妥当かを確かめる（CONTENT_PLANNING 7.3）。
 *
 * **`JSON.stringify` → `JSON.parse` を通す。** 循環参照や `undefined`、
 * `NaN` が混ざっていれば、ここで文字列にできないか、往復して形が変わる。
 * そのうえで JSON-LD として最低限必要な `@context` `@type` を確かめる。
 *
 * @throws {AppError} JSONにできない、または JSON-LD の体を成していない
 */
export function assertValidJsonLd(blocks: readonly JsonLdBlock[]): void {
  if (blocks.length === 0) {
    throw invalidStructuredDataError('構造化データが空です');
  }

  let roundTripped: unknown;

  try {
    roundTripped = JSON.parse(JSON.stringify(blocks));
  } catch {
    // **元の例外を持ち回らない。** 記事本文が混ざりうる（SPEC 14.2）
    throw invalidStructuredDataError('JSONに変換できません');
  }

  if (!Array.isArray(roundTripped)) {
    throw invalidStructuredDataError('構造化データが配列ではありません');
  }

  for (const block of roundTripped) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw invalidStructuredDataError(
        '構造化データにオブジェクト以外があります',
      );
    }

    const entry = block as Record<string, unknown>;

    if (entry['@context'] !== SCHEMA_CONTEXT) {
      throw invalidStructuredDataError('@context が schema.org ではありません');
    }

    if (typeof entry['@type'] !== 'string' || entry['@type'] === '') {
      throw invalidStructuredDataError('@type がありません');
    }

    if (entry['@type'] === 'FAQPage') {
      const mainEntity = entry['mainEntity'];

      if (!Array.isArray(mainEntity) || mainEntity.length === 0) {
        throw invalidStructuredDataError('FAQPage に質問がありません');
      }
    }
  }
}
