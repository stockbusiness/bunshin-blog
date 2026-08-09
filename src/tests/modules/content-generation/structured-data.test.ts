import { describe, expect, it } from 'vitest';
import {
  PROMPT_ERROR_CODES,
  assertValidJsonLd,
  buildStructuredData,
  type JsonLdBlock,
} from '@/modules/content-generation';

/**
 * JSON-LD の組み立て（TASKS E-11、CONTENT_PLANNING 7.3）。
 *
 * > **AIに生成させない。** `faq` と記事種別から**コードで組み立てる**
 *
 * 完了条件は「JSON-LDが構文的に妥当」。
 */

const faq = [
  { question: '料金はいくらですか？', answer: '月額500円です' },
  { question: '解約はできますか？', answer: 'いつでもできます' },
  { question: '対応端末は？', answer: '主要な機種に対応しています' },
];

const capsule = 'この記事の結論です';

function build(overrides: Partial<Parameters<typeof buildStructuredData>[0]>) {
  return buildStructuredData({
    contentType: 'INFORMATIONAL',
    faq,
    answerCapsule: capsule,
    offerName: null,
    authorName: 'たなか',
    ...overrides,
  });
}

describe('記事種別で組み立てが変わる（CONTENT_PLANNING 7.3）', () => {
  it('集客記事は FAQPage だけ', () => {
    const blocks = build({});

    expect(blocks.map((block) => block['@type'])).toEqual(['FAQPage']);
  });

  it('収益記事は FAQPage と Review', () => {
    const blocks = build({ contentType: 'AFFILIATE', offerName: '案件A' });

    expect(blocks.map((block) => block['@type'])).toEqual([
      'FAQPage',
      'Review',
    ]);
  });

  it('比較記事は FAQPage だけ（AFFILIATE ではない）', () => {
    const blocks = build({ contentType: 'COMPARISON' });

    expect(blocks.map((block) => block['@type'])).toEqual(['FAQPage']);
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

describe('Review（収益記事）', () => {
  function review(): Record<string, unknown> {
    return build({ contentType: 'AFFILIATE', offerName: '案件A' })[1] as Record<
      string,
      unknown
    >;
  }

  it('案件名が itemReviewed になる', () => {
    expect(review()['itemReviewed']).toEqual({
      '@type': 'Product',
      name: '案件A',
    });
  });

  it('ペンネームが author になる', () => {
    expect(review()['author']).toEqual({ '@type': 'Person', name: 'たなか' });
  });

  it('ペンネームが無ければ author を入れない', () => {
    const blocks = build({
      contentType: 'AFFILIATE',
      offerName: '案件A',
      authorName: null,
    });

    expect(blocks[1]).not.toHaveProperty('author');
  });

  /**
   * **評点を作らない。** 出どころが無い数字を入れると
   * 「根拠のないランキング」（SPEC 9.6）と同じことになる。Q-021
   */
  it('reviewRating を入れない', () => {
    expect(review()).not.toHaveProperty('reviewRating');
  });

  /** **黙って Review を省かない。** 案件が無いのは構成表の側の異常 */
  it('収益記事なのに案件名が無ければ落ちる', () => {
    expect(() =>
      build({ contentType: 'AFFILIATE', offerName: null }),
    ).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });

  it('案件名が空白だけでも落ちる', () => {
    expect(() =>
      build({ contentType: 'AFFILIATE', offerName: '   ' }),
    ).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidStructuredData,
      }),
    );
  });
});

describe('構文の検証（完了条件）', () => {
  it('組み立てた結果は JSON にできる', () => {
    const blocks = build({ contentType: 'AFFILIATE', offerName: '案件A' });

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
