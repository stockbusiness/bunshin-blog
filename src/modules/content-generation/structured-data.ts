/**
 * JSON-LD の組み立て（TASKS E-11・E-16、CONTENT_PLANNING 7.3）。
 *
 * ## `Review` を出さない（E-16・Q-021）
 *
 * CONTENT_PLANNING 7.3 は当初「収益記事には `FAQPage` と `Review`」と
 * していたが、**評点の出どころが無い。**
 *
 * 分身は案件の `facts` の範囲でしか書けず（SPEC 9.6）、
 * 「5段階で4.5」という数字はどこにも存在しない。作り出せば、
 * **SPEC 9.6 が禁じる「根拠のないランキング」そのもの**になる。
 *
 * 一方 Google の `Review` は `reviewRating` を必須としており、
 * **評点なしで出してもリッチリザルトの対象にならない。**
 * つまり「出す」ことの目的は果たせないまま、根拠のない申告の形だけが残る。
 *
 * **出さない。** 承認画面でモニターに評点を入力させる案は、
 * 短期KPIが「承認率」と「1記事当たり確認時間」（SPEC 11.1）である以上、
 * **承認1回あたりの負担を増やすので採らない**（Q-021 の (a)）。
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

/**
 * 組み立ての入力。
 *
 * **記事種別・案件名・ペンネームを受け取らない**（E-16）。`Review` を
 * 出さなくなり、収益記事とそれ以外で出すものが変わらなくなったため。
 * **使わない値を受け取り続けると、「渡せば何かに使われる」と読める。**
 */
export interface BuildStructuredDataInput {
  faq: readonly StructuredDataFaq[];
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
 * FAQ から JSON-LD を組み立てる（CONTENT_PLANNING 7.3、E-16）。
 *
 * **出すのは `FAQPage` だけ。** 記事種別によらない（`Review` は Q-021 で
 * 出さないと決めた。理由はこのファイルの冒頭）。
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
