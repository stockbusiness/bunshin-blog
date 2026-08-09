import { describe, expect, it } from 'vitest';
import {
  ANSWER_CAPSULE_MAX_LENGTH,
  ANSWER_CAPSULE_MIN_LENGTH,
  FAQ_MAX_COUNT,
  FAQ_MIN_COUNT,
  PROMPT_ERROR_CODES,
  articleContentHash,
  assertAllowedLinks,
  assertAnswerCapsule,
  assertFaq,
  assertNoH1,
  assertPrDisclosure,
  assertUsedFacts,
  composeBodyWithCapsule,
  countCharacters,
  extractHrefs,
  operationForContentType,
} from '@/modules/content-generation';

/**
 * 生成された記事の検査（TASKS E-10、CONTENT_PLANNING 7.2）。
 *
 * > プロンプトに明記し、**かつ受信後にコードで検査する**
 *
 * **AIの申告を信じない。** 「指定されたリンクだけ使いました」と
 * 言われても、本文から実際に抜き出して確かめる。
 */

describe('リンクの抜き出し', () => {
  it.each([
    ['<a href="https://example.com/a">x</a>', ['https://example.com/a']],
    ["<a href='https://example.com/b'>x</a>", ['https://example.com/b']],
    ['<a href=https://example.com/c>x</a>', ['https://example.com/c']],
    ['<a class="x" href="/rel" rel="nofollow">y</a>', ['/rel']],
  ])('%s から抜き出す', (html, expected) => {
    expect(extractHrefs(html)).toEqual(expected);
  });

  it('複数のリンクを全て取る', () => {
    const html =
      '<p><a href="#a">1</a>と<a href="https://example.com">2</a></p>';

    expect(extractHrefs(html)).toEqual(['#a', 'https://example.com']);
  });

  it('リンクが無ければ空', () => {
    expect(extractHrefs('<p>本文だけ</p>')).toEqual([]);
  });
});

describe('許されたリンクだけを含む', () => {
  const allowed = ['#item-1', 'https://asp.example/click?a=x'];

  it('許可されたリンクは通る', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="#item-1">内部</a>',
        allowedUrls: allowed,
      }),
    ).not.toThrow();
  });

  /** **外部サイトへ自由にリンクさせない**（意図しない誘導・ASP規約） */
  it('知らないリンクは落とす', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="https://evil.example">外部</a>',
        allowedUrls: allowed,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: PROMPT_ERROR_CODES.invalidArticle,
        status: 422,
      }),
    );
  });

  it('1つでも混ざれば落とす', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml:
          '<a href="#item-1">よい</a><a href="https://evil.example">わるい</a>',
        allowedUrls: allowed,
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  /** ページ内アンカーは目次に使う */
  it('ページ内アンカーは通す', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="#toc-1">目次</a>',
        allowedUrls: [],
      }),
    ).not.toThrow();
  });

  /** 末尾のスラッシュや大小文字の揺れで正しいリンクを弾かない */
  it('URLの揺れを吸収する', () => {
    expect(() =>
      assertAllowedLinks({
        bodyHtml: '<a href="https://ASP.example/click?a=x/">リンク</a>',
        allowedUrls: allowed,
      }),
    ).not.toThrow();
  });
});

describe('PR表記（SPEC 15.2）', () => {
  /** **広告リンクがあるなら要る。** 記事の種別ではなくリンクの有無で決まる */
  it('広告リンクがあるのに表記が無ければ落とす', () => {
    expect(() =>
      assertPrDisclosure({
        bodyHtml: '<p>おすすめです</p>',
        hasAffiliateLink: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it.each([
    ['<p>本記事は広告を含みます</p>'],
    ['<p>【PR】おすすめ</p>'],
    ['<p>アフィリエイト広告を利用しています</p>'],
    ['<p>プロモーションを含みます</p>'],
  ])('%s は表記として認める', (bodyHtml) => {
    expect(() =>
      assertPrDisclosure({ bodyHtml, hasAffiliateLink: true }),
    ).not.toThrow();
  });

  it('広告リンクが無ければ表記は要らない', () => {
    expect(() =>
      assertPrDisclosure({
        bodyHtml: '<p>ただの記事</p>',
        hasAffiliateLink: false,
      }),
    ).not.toThrow();
  });
});

describe('使った事実の照合', () => {
  /** **知らない事実IDを申告させない** */
  it('渡していない事実は落とす', () => {
    expect(() =>
      assertUsedFacts({
        usedFactIds: ['fact-x'],
        availableFactIds: ['fact-1'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it('渡した事実だけなら通る', () => {
    expect(() =>
      assertUsedFacts({
        usedFactIds: ['fact-1'],
        availableFactIds: ['fact-1', 'fact-2'],
      }),
    ).not.toThrow();
  });

  it('1件も使わなくても通る', () => {
    expect(() =>
      assertUsedFacts({ usedFactIds: [], availableFactIds: ['fact-1'] }),
    ).not.toThrow();
  });
});

describe('本文のハッシュ', () => {
  it('同じ内容なら同じ値', () => {
    const a = articleContentHash({ title: 'T', bodyHtml: '<p>x</p>' });
    const b = articleContentHash({ title: 'T', bodyHtml: '<p>x</p>' });

    expect(a).toBe(b);
  });

  it('タイトルが変われば違う値', () => {
    expect(articleContentHash({ title: 'A', bodyHtml: '<p>x</p>' })).not.toBe(
      articleContentHash({ title: 'B', bodyHtml: '<p>x</p>' }),
    );
  });
});

/** 87字。80〜120字の範囲に入る（SPEC 9.5） */
const CAPSULE =
  'この記事では、月額500円から使える格安SIMの選び方を、通信速度・料金・サポート体制の3つの観点から比較し、初めて乗り換える方が失敗しないための手順まで具体的に説明します。';

describe('アンサーカプセルの文字数（CONTENT_PLANNING 7.2）', () => {
  it('80〜120字なら通る', () => {
    expect(() => assertAnswerCapsule(CAPSULE)).not.toThrow();
  });

  it('短すぎれば落とす', () => {
    expect(() => assertAnswerCapsule('結論です。')).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it('長すぎれば落とす', () => {
    expect(() => assertAnswerCapsule(CAPSULE + CAPSULE)).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it.each([
    [ANSWER_CAPSULE_MIN_LENGTH, true],
    [ANSWER_CAPSULE_MIN_LENGTH - 1, false],
    [ANSWER_CAPSULE_MAX_LENGTH, true],
    [ANSWER_CAPSULE_MAX_LENGTH + 1, false],
  ])('%d字は %s', (length, allowed) => {
    const text = 'あ'.repeat(length);

    if (allowed) {
      expect(() => assertAnswerCapsule(text)).not.toThrow();
    } else {
      expect(() => assertAnswerCapsule(text)).toThrow();
    }
  });

  /**
   * **`String.length` で数えない。** サロゲートペアを2文字と数えると、
   * 範囲に収まっている結論を「長すぎる」と落としてしまう
   */
  it('サロゲートペアを1文字と数える', () => {
    const text = '𠮷'.repeat(ANSWER_CAPSULE_MAX_LENGTH);

    expect(countCharacters(text)).toBe(ANSWER_CAPSULE_MAX_LENGTH);
    expect(text.length).toBe(ANSWER_CAPSULE_MAX_LENGTH * 2);
    expect(() => assertAnswerCapsule(text)).not.toThrow();
  });
});

describe('FAQ（SPEC 9.5）', () => {
  const entries = [
    { question: '料金は？', answer: '月額500円です' },
    { question: '解約できますか？', answer: 'できます' },
    { question: '対応端末は?', answer: '主要機種です' },
  ];

  it('3〜5件で疑問形なら通る', () => {
    expect(() => assertFaq(entries)).not.toThrow();
  });

  it.each([[FAQ_MIN_COUNT - 1], [FAQ_MAX_COUNT + 1]])(
    '%d件は落とす',
    (count) => {
      const many = Array.from({ length: count }, (_, index) => ({
        question: `質問${index}は？`,
        answer: '回答',
      }));

      expect(() => assertFaq(many)).toThrowError(
        expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
      );
    },
  );

  /** JSON-LD の `Question` になるため、疑問形でないとそのまま検索結果に出る */
  it('疑問形でない見出しは落とす', () => {
    expect(() =>
      assertFaq([
        ...entries.slice(1),
        { question: '料金について', answer: '月額500円です' },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });
});

describe('結論をH1直後に置く（E-11 の完了条件）', () => {
  /** **H1は記事タイトルが担う。** 本文の先頭＝H1直後 */
  it('本文に h1 があれば落とす', () => {
    expect(() => assertNoH1('<h1>見出し</h1><p>本文</p>')).toThrowError(
      expect.objectContaining({ code: PROMPT_ERROR_CODES.invalidArticle }),
    );
  });

  it('h2 以下は通す', () => {
    expect(() => assertNoH1('<h2>見出し</h2><p>本文</p>')).not.toThrow();
  });

  it('カプセルを本文の先頭に置く', () => {
    const body = composeBodyWithCapsule({
      answerCapsule: CAPSULE,
      bodyHtml: '<h2>見出し</h2>',
    });

    expect(body).toBe(
      `<p class="answer-capsule">${CAPSULE}</p><h2>見出し</h2>`,
    );
  });

  /** 同じ結論が二度並ぶ記事にしない */
  it('本文に既に含まれていれば足さない', () => {
    const bodyHtml = `<p>${CAPSULE}</p><h2>見出し</h2>`;

    expect(composeBodyWithCapsule({ answerCapsule: CAPSULE, bodyHtml })).toBe(
      bodyHtml,
    );
  });

  /** **カプセルもAIの出力。** タグとして解釈させない */
  it('カプセルのHTMLを打ち消す', () => {
    const body = composeBodyWithCapsule({
      answerCapsule: '<script>alert(1)</script>',
      bodyHtml: '<p>本文</p>',
    });

    expect(body).toContain('&lt;script&gt;');
    expect(body).not.toContain('<script>');
  });
});

describe('記事の種別から段を決める', () => {
  /** **呼び出し側にモデル名を書かせない**（E-3） */
  it.each([
    ['AFFILIATE', 'PRIORITY_ARTICLE'],
    ['COMPARISON', 'COMPARISON'],
    ['INFORMATIONAL', 'ARTICLE_BODY'],
    ['FAQ', 'ARTICLE_BODY'],
  ])('%s → %s', (contentType, expected) => {
    expect(operationForContentType(contentType)).toBe(expected);
  });
});
