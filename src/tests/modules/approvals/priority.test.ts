import { describe, expect, it } from 'vitest';
import {
  NEVER_PROPOSED_POINTS,
  buildProposalReason,
  openProposalPenalty,
  publishOrderPoints,
  rankProposals,
  riskPenalty,
  scoreCandidate,
  waitingPoints,
  type BlogProposalState,
  type ProposalCandidate,
} from '@/modules/approvals';

/**
 * 提案の優先順位（TASKS F-1、SPEC 9.1「3ブログ横断で優先順位を付ける」）。
 *
 * 完了条件は「優先度と提案理由が保存される」。
 *
 * **点の付け方は仕様に無い**（Q-024）。ここで確かめるのは、置いた式が
 * 意図どおりに効くこと。
 */

const NOW = new Date('2026-08-10T00:00:00.000Z');

function candidate(
  overrides: Partial<ProposalCandidate> = {},
): ProposalCandidate {
  return {
    contentItemId: 'item-1',
    blogId: 'blog-1',
    articleVersionId: 'version-1',
    title: '記事',
    contentType: 'INFORMATIONAL',
    objective: 'TRAFFIC',
    publishPriority: 1,
    outboundLinkCount: 0,
    factCheckStatus: 'PASSED',
    warningFlagCount: 0,
    ...overrides,
  };
}

function blog(overrides: Partial<BlogProposalState> = {}): BlogProposalState {
  return {
    blogId: 'blog-1',
    blogName: 'ブログ',
    lastProposedAt: NOW,
    openProposalCount: 0,
    ...overrides,
  };
}

describe('公開順序の点（構成表の判断をそのまま使う）', () => {
  /** **同じ判断を二度しない。** 収益記事の先行は E-9 が済ませている */
  it('1番目が最も高い', () => {
    expect(publishOrderPoints(1)).toBeGreaterThan(publishOrderPoints(2));
  });

  it('順に下がる', () => {
    expect(publishOrderPoints(1)).toBe(100);
    expect(publishOrderPoints(3)).toBe(90);
  });

  it('負にはならない', () => {
    expect(publishOrderPoints(100)).toBe(0);
  });
});

describe('待たせているブログを上げる（SPEC 8.3 で1日1件）', () => {
  /**
   * **これが無いと3ブログのうち1つだけが進み続ける。**
   * 残り2つのブログは永久に提案が出ない
   */
  it('一度も提案していないブログが最も高い', () => {
    expect(waitingPoints({ lastProposedAt: null, now: NOW })).toBe(
      NEVER_PROPOSED_POINTS,
    );
  });

  it('日が経つほど上がる', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1_000);
    const oneDayAgo = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1_000);

    expect(
      waitingPoints({ lastProposedAt: threeDaysAgo, now: NOW }),
    ).toBeGreaterThan(waitingPoints({ lastProposedAt: oneDayAgo, now: NOW }));
  });

  it('上限で止まる', () => {
    const long = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1_000);
    const capped = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1_000);

    expect(waitingPoints({ lastProposedAt: long, now: NOW })).toBe(
      waitingPoints({ lastProposedAt: capped, now: NOW }),
    );
  });

  it('同日なら0', () => {
    expect(waitingPoints({ lastProposedAt: NOW, now: NOW })).toBe(0);
  });
});

describe('未回答の提案があるブログを下げる', () => {
  /** **返事が来ていないのに次を積まない** */
  it('件数が増えるほど下がる', () => {
    expect(openProposalPenalty(1)).toBeLessThan(openProposalPenalty(0));
    expect(openProposalPenalty(2)).toBeLessThan(openProposalPenalty(1));
  });

  it('上限で止まる', () => {
    expect(openProposalPenalty(10)).toBe(openProposalPenalty(2));
  });

  it('0件なら引かない', () => {
    expect(openProposalPenalty(0)).toBe(0);
  });
});

describe('手のかかる記事を少し下げる', () => {
  /**
   * **落とすためではない。** `FAILED` と `error` は候補に入らない
   * （E-12・E-13）。同点なら手のかからないほうを先に見せる程度の重み
   */
  it('WARNING は少し下がる', () => {
    expect(
      riskPenalty({ factCheckStatus: 'WARNING', warningFlagCount: 0 }),
    ).toBeLessThan(0);
  });

  it('リスクフラグの数だけ下がる', () => {
    expect(
      riskPenalty({ factCheckStatus: 'PASSED', warningFlagCount: 2 }),
    ).toBeLessThan(
      riskPenalty({ factCheckStatus: 'PASSED', warningFlagCount: 1 }),
    );
  });

  it('上限で止まる', () => {
    expect(
      riskPenalty({ factCheckStatus: 'PASSED', warningFlagCount: 9 }),
    ).toBe(riskPenalty({ factCheckStatus: 'PASSED', warningFlagCount: 3 }));
  });

  /** **公開順序を覆すほど大きくしない** */
  it('公開順序1つ分より小さい', () => {
    const worst = riskPenalty({
      factCheckStatus: 'WARNING',
      warningFlagCount: 9,
    });

    expect(Math.abs(worst)).toBeLessThan(publishOrderPoints(1));
  });
});

describe('3ブログ横断の並び（SPEC 9.1）', () => {
  it('点の高い順に並ぶ', () => {
    const ranked = rankProposals({
      candidates: [
        candidate({ contentItemId: 'late', publishPriority: 5 }),
        candidate({ contentItemId: 'early', publishPriority: 1 }),
      ],
      blogs: [blog()],
      now: NOW,
    });

    expect(ranked.map((entry) => entry.candidate.contentItemId)).toEqual([
      'early',
      'late',
    ]);
  });

  /**
   * **待たせているブログが勝つ。** 公開順序が同じなら、
   * 提案の出ていないブログを先に見せる
   */
  it('同じ公開順序なら待たせているブログが先', () => {
    const ranked = rankProposals({
      candidates: [
        candidate({ contentItemId: 'a', blogId: 'blog-active' }),
        candidate({
          contentItemId: 'b',
          blogId: 'blog-quiet',
          articleVersionId: 'version-2',
        }),
      ],
      blogs: [
        blog({ blogId: 'blog-active', lastProposedAt: NOW }),
        blog({ blogId: 'blog-quiet', lastProposedAt: null }),
      ],
      now: NOW,
    });

    expect(ranked[0]?.candidate.blogId).toBe('blog-quiet');
  });

  /** **呼ぶたびに順番が入れ替わらない**（E-9 の並びと同じ考え） */
  it('同点は blogId と contentItemId で決める', () => {
    const input = {
      candidates: [
        candidate({ contentItemId: 'z', blogId: 'blog-1' }),
        candidate({ contentItemId: 'a', blogId: 'blog-1' }),
      ],
      blogs: [blog()],
      now: NOW,
    };

    const first = rankProposals(input).map((e) => e.candidate.contentItemId);
    const second = rankProposals(input).map((e) => e.candidate.contentItemId);

    expect(first).toEqual(['a', 'z']);
    expect(second).toEqual(first);
  });

  /** **絞り込みが漏れていても他人のブログの記事を提案しない** */
  it('知らないブログの記事は落とす', () => {
    const ranked = rankProposals({
      candidates: [candidate({ blogId: 'blog-someone-else' })],
      blogs: [blog({ blogId: 'blog-1' })],
      now: NOW,
    });

    expect(ranked).toEqual([]);
  });

  it('点と理由の両方を返す（完了条件）', () => {
    const ranked = rankProposals({
      candidates: [candidate()],
      blogs: [blog()],
      now: NOW,
    });

    expect(typeof ranked[0]?.priorityScore).toBe('number');
    expect(ranked[0]?.proposalReason.length).toBeGreaterThan(0);
  });
});

describe('提案理由（AIに書かせない）', () => {
  it('収益記事はそう書く', () => {
    const reason = buildProposalReason({
      candidate: candidate({ contentType: 'AFFILIATE' }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).toContain('収益記事');
  });

  /** SPEC 8.2 の「通常記事から収益記事へ読者を誘導します」 */
  it('リンクを張る集客記事は誘導すると書く', () => {
    const reason = buildProposalReason({
      candidate: candidate({ outboundLinkCount: 1 }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).toContain('誘導');
  });

  it('リンクが無ければ誘導と書かない', () => {
    const reason = buildProposalReason({
      candidate: candidate({ outboundLinkCount: 0 }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).not.toContain('誘導');
  });

  it('初めての提案はそう書く', () => {
    const reason = buildProposalReason({
      candidate: candidate(),
      blog: blog({ lastProposedAt: null }),
      now: NOW,
    });

    expect(reason).toContain('初めて');
  });

  /** **確かめる手間を先に伝える。** 開いてから気づくより早い */
  it('WARNING は理由に出す', () => {
    const reason = buildProposalReason({
      candidate: candidate({ factCheckStatus: 'WARNING' }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).toContain('未確認の事実');
  });

  it('リスクフラグの件数を出す', () => {
    const reason = buildProposalReason({
      candidate: candidate({ warningFlagCount: 2 }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).toContain('2件');
  });

  it('公開順を必ず書く', () => {
    const reason = buildProposalReason({
      candidate: candidate({ publishPriority: 7 }),
      blog: blog(),
      now: NOW,
    });

    expect(reason).toContain('7番目');
  });
});

describe('点の合計', () => {
  it('全ての要素が効く', () => {
    const best = scoreCandidate({
      candidate: candidate({ publishPriority: 1 }),
      blog: blog({ lastProposedAt: null, openProposalCount: 0 }),
      now: NOW,
    });

    const worst = scoreCandidate({
      candidate: candidate({
        publishPriority: 10,
        factCheckStatus: 'WARNING',
        warningFlagCount: 3,
      }),
      blog: blog({ lastProposedAt: NOW, openProposalCount: 2 }),
      now: NOW,
    });

    expect(best).toBeGreaterThan(worst);
  });

  it('整数を返す（priority_score は integer）', () => {
    const score = scoreCandidate({
      candidate: candidate(),
      blog: blog(),
      now: NOW,
    });

    expect(Number.isInteger(score)).toBe(true);
  });
});
