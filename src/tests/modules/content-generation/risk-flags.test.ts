import { describe, expect, it } from 'vitest';
import {
  canSendToApproval,
  detectNgExpressions,
  detectPrDisclosureMissing,
  detectProhibitedExpressions,
  detectRiskFlags,
  hasBlockingRiskFlag,
  stripTags,
  type RiskFlag,
} from '@/modules/content-generation';

/**
 * 禁止表現の検出とリスクフラグ（TASKS E-13、SPEC 9.6）。
 *
 * 完了条件は「**PR表記欠落と断定表現を検出**」。
 *
 * **語彙で拾える範囲しか拾えない。** ここを通ったから安全なのではなく、
 * 明らかなものを機械が先に落とすための仕組み。
 */

function codes(flags: readonly RiskFlag[]): string[] {
  return flags.map((flag) => flag.code);
}

describe('タグを外して本文だけを見る', () => {
  /** `<a href="...ranking...">` の属性を本文として拾わない */
  it('属性の中身は検査の対象にしない', () => {
    expect(stripTags('<a href="https://x/ranking">リンク</a>')).toBe('リンク');
  });

  it('タグの前後を繋げる', () => {
    expect(stripTags('<p>あ</p><p>い</p>')).toBe('あ い');
  });
});

describe('PR表記の欠落（完了条件）', () => {
  it('広告リンクがあるのに表記が無ければ error', () => {
    const flags = detectPrDisclosureMissing({
      bodyHtml: '<p>おすすめです</p>',
      hasAffiliateLink: true,
    });

    expect(codes(flags)).toEqual(['PR_DISCLOSURE_MISSING']);
    expect(flags[0]?.severity).toBe('error');
  });

  it('表記があれば付かない', () => {
    expect(
      detectPrDisclosureMissing({
        bodyHtml: '<p>本記事は広告を含みます</p>',
        hasAffiliateLink: true,
      }),
    ).toEqual([]);
  });

  /** **記事の種別ではなく広告リンクの有無で決まる**（SPEC 15.2） */
  it('広告リンクが無ければ付かない', () => {
    expect(
      detectPrDisclosureMissing({
        bodyHtml: '<p>ただの記事</p>',
        hasAffiliateLink: false,
      }),
    ).toEqual([]);
  });
});

describe('断定表現（完了条件）', () => {
  it.each([
    ['<p>絶対に損はしません</p>'],
    ['<p>誰でも簡単に稼げます</p>'],
    ['<p>100%成功します</p>'],
    ['<p>間違いなくおすすめです</p>'],
  ])('%s を拾う', (bodyHtml) => {
    expect(codes(detectProhibitedExpressions(bodyHtml))).toContain(
      'ASSERTIVE_CLAIM',
    );
  });

  /**
   * **断定は `warning`。** 文脈によっては正しい
   * （「必ず本人確認が要ります」など）ので、落とさず人に見せる
   */
  it('断定は承認を止めない', () => {
    const flags = detectProhibitedExpressions('<p>間違いなくおすすめです</p>');

    expect(hasBlockingRiskFlag(flags)).toBe(false);
  });

  it('穏やかな文には付かない', () => {
    expect(
      detectProhibitedExpressions('<p>人によって向き不向きがあります</p>'),
    ).toEqual([]);
  });
});

describe('高リスク助言（SPEC 9.6）', () => {
  /** **薬機法・金商法に触れうる。** 分身が言ってよい範囲の外 */
  it.each([
    ['<p>飲むだけで治ります</p>'],
    ['<p>元本保証なので安心です</p>'],
    ['<p>必ず儲かります</p>'],
    ['<p>副作用はありません</p>'],
  ])('%s は error', (bodyHtml) => {
    const flags = detectProhibitedExpressions(bodyHtml);

    expect(codes(flags)).toContain('HIGH_RISK_ADVICE');
    expect(hasBlockingRiskFlag(flags)).toBe(true);
  });
});

describe('誇大・ランキング・口コミ（SPEC 9.6）', () => {
  it.each([
    ['<p>業界No.1のサービスです</p>', 'EXAGGERATION'],
    ['<p>最安で使えます</p>', 'EXAGGERATION'],
    ['<p>おすすめランキングを紹介します</p>', 'RANKING_WITHOUT_BASIS'],
    ['<p>利用者の声を集めました</p>', 'FABRICATED_REVIEW'],
  ])('%s → %s', (bodyHtml, code) => {
    expect(codes(detectProhibitedExpressions(bodyHtml))).toContain(code);
  });

  /** **同じ指摘が並ぶと他の指摘が埋もれる** */
  it('同じ code は1件にまとめる', () => {
    const flags = detectProhibitedExpressions(
      '<p>最安です。業界No.1です。最強です。</p>',
    );

    expect(codes(flags).filter((code) => code === 'EXAGGERATION')).toHaveLength(
      1,
    );
  });

  /** 承認画面が該当箇所を示せるように、前後を切り出す */
  it('見つかった箇所を切り出す', () => {
    const flags = detectProhibitedExpressions('<p>この商品は最安です</p>');

    expect(flags[0]?.excerpt).toContain('最安');
  });
});

describe('利用者が禁じた表現（D-5）', () => {
  /** **本人が明示的に挙げた語。**「文脈によっては良い」の余地が無い */
  it('NG表現は error', () => {
    const flags = detectNgExpressions({
      bodyHtml: '<p>これは絶対におすすめです</p>',
      ngExpressions: ['絶対に'],
    });

    expect(codes(flags)).toEqual(['NG_EXPRESSION']);
    expect(flags[0]?.severity).toBe('error');
    expect(flags[0]?.message).toContain('絶対に');
  });

  it('含まれていなければ付かない', () => {
    expect(
      detectNgExpressions({
        bodyHtml: '<p>おすすめです</p>',
        ngExpressions: ['絶対に'],
      }),
    ).toEqual([]);
  });

  it('空文字は無視する', () => {
    expect(
      detectNgExpressions({
        bodyHtml: '<p>おすすめです</p>',
        ngExpressions: ['', '  '],
      }),
    ).toEqual([]);
  });

  it('複数の語をそれぞれ拾う', () => {
    const flags = detectNgExpressions({
      bodyHtml: '<p>絶対に、しかも激安です</p>',
      ngExpressions: ['絶対に', '激安'],
    });

    expect(flags).toHaveLength(2);
  });
});

describe('まとめて拾う', () => {
  it('PR表記・NG表現・禁止表現を全て返す', () => {
    const flags = detectRiskFlags({
      bodyHtml: '<p>絶対に治ります</p>',
      hasAffiliateLink: true,
      ngExpressions: ['絶対に'],
    });

    expect(codes(flags)).toEqual([
      'PR_DISCLOSURE_MISSING',
      'NG_EXPRESSION',
      'HIGH_RISK_ADVICE',
      'ASSERTIVE_CLAIM',
    ]);
  });

  it('問題が無ければ空', () => {
    expect(
      detectRiskFlags({
        bodyHtml: '<p>人によって向き不向きがあります</p>',
        hasAffiliateLink: false,
        ngExpressions: [],
      }),
    ).toEqual([]);
  });
});

describe('承認へ送ってよいかの唯一の判定', () => {
  /** **片方だけを見る経路を作らない** */
  it('事実チェックが通っても error のフラグがあれば送らない', () => {
    expect(
      canSendToApproval({
        factCheckStatus: 'PASSED',
        riskFlags: [
          {
            code: 'NG_EXPRESSION',
            severity: 'error',
            message: 'x',
            excerpt: 'x',
          },
        ],
      }),
    ).toBe(false);
  });

  it('フラグが無くても FAILED なら送らない', () => {
    expect(
      canSendToApproval({ factCheckStatus: 'FAILED', riskFlags: [] }),
    ).toBe(false);
  });

  it('warning は止めない', () => {
    expect(
      canSendToApproval({
        factCheckStatus: 'WARNING',
        riskFlags: [
          {
            code: 'ASSERTIVE_CLAIM',
            severity: 'warning',
            message: 'x',
            excerpt: 'x',
          },
        ],
      }),
    ).toBe(true);
  });

  it('両方とも問題なければ送れる', () => {
    expect(
      canSendToApproval({ factCheckStatus: 'PASSED', riskFlags: [] }),
    ).toBe(true);
  });
});
