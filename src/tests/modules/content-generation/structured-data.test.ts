import { describe, expect, it } from 'vitest';
import {
  PROMPT_ERROR_CODES,
  assertValidJsonLd,
  buildStructuredData,
  type JsonLdBlock,
} from '@/modules/content-generation';

/**
 * JSON-LD の組み立て（TASKS E-11・E-16、CONTENT_PLANNING 7.3）。
 *
 * > **AIに生成させない。** `faq` から**コードで組み立てる**
 *
 * 完了条件は「JSON-LDが構文的に妥当」。**出すのは `FAQPage` だけ**（E-16）。
 */

const faq = [
  { question: '料金はいくらですか？', answer: '月額500円です' },
  { question: '解約はできますか？', answer: 'いつでもできます' },
  { question: '対応端末は？', answer: '主要な機種に対応しています' },
];

function build(overrides: Partial<Parameters<typeof buildStructuredData>[0]>) {
  return buildStructuredData({ faq, ...overrides });
}

/**
 * **`Review` を出さない**（E-16・Q-021）。
 *
 * 評点の出どころが無く、作り出せば SPEC 9.6 が禁じる
 * 「根拠のないランキング」そのものになる。Google の `Review` は
 * `reviewRating` を必須とするため、**評点なしで出しても
 * リッチリザルトの対象にならない** — 目的を果たさないまま、
 * 根拠のない申告の形だけが残る
 */
describe('出すのは FAQPage だけ（E-16）', () => {
  it.each(['INFORMATIONAL', 'AFFILIATE', 'COMPARISON', 'EXPERIENCE', 'FAQ'])(
    '%s でも FAQPage だけ',
    () => {
      const blocks = build({});

      expect(blocks.map((block) => block['@type'])).toEqual(['FAQPage']);
    },
  );

  /** 評点そのものが、どこにも出ない */
  it('Review も reviewRating も出さない', () => {
    const serialized = JSON.stringify(build({}));

    expect(serialized).not.toContain('Review');
    expect(serialized).not.toContain('reviewRating');
  });
});

describe('FAQPage の中身は faq から取る', () => {
  it('質問と回答がそのまま入る', () => {
    const page = build({})[0] as JsonLdBlock;
    const questions = page['mainEntity'] as Record<string, unknown>[];

    expect(questions).toHaveLength(3);
    expect(questions[0]).toEqual({
      '@type': 'Question',
      name: '料金はいくらですか？',
      acceptedAnswer: { '@type': 'Answer', text: '月額500円です' },
    });
  });

  /** FAQ が無ければ FAQPage を作れない */
  it('FAQ が空なら落ちる', () => {
    expect(() => build({ faq: [] })).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
        status: 500,
      }),
    );
  });
});

describe('構文の検証（完了条件）', () => {
  it('組み立てた結果は JSON にできる', () => {
    const blocks = build({});

    expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks);
  });

  it('空の配列は通さない', () => {
    expect(() => assertValidJsonLd([])).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });

  /** 循環参照は `JSON.stringify` の時点で落ちる */
  it('循環参照は通さない', () => {
    const block: Record<string, unknown> = { '@context': 'https://schema.org' };
    block['self'] = block;

    expect(() => assertValidJsonLd([block as JsonLdBlock])).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });

  it.each([
    {
      reason: '@context が無い',
      block: { '@type': 'FAQPage', mainEntity: [] },
    },
    {
      reason: '別の @context',
      block: { '@context': 'https://example.com', '@type': 'FAQPage' },
    },
    { reason: '@type が無い', block: { '@context': 'https://schema.org' } },
    {
      reason: 'FAQPage に質問が無い',
      block: {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [],
      },
    },
    {
      reason: 'FAQPage に mainEntity が無い',
      block: { '@context': 'https://schema.org', '@type': 'FAQPage' },
    },
  ])('$reason は通さない', ({ block }) => {
    expect(() => assertValidJsonLd([block as JsonLdBlock])).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });

  it('オブジェクト以外は通さない', () => {
    expect(() =>
      assertValidJsonLd(['文字列' as unknown as JsonLdBlock]),
    ).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });
});
