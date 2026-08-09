import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_CODES,
  INBOUND_MIN,
  OUTBOUND_MAX,
  TOTAL_ARTICLE_MAX,
  WEEKLY_PUBLISH_CAP,
  buildRepairHints,
  checkConstraints,
  type CheckableItem,
} from '@/modules/content-planning';

/**
 * 制約チェック（TASKS E-8、SPEC 9.2.6、DATA_MODEL 4章）。
 *
 * 完了条件「**SPEC 9.2.6の全項目を判定**」。
 *
 * **1つでも欠ければ不合格。**「だいたい通っている」を返さない —
 * 暫定的な構成表を承認依頼へ送ってはならない（SPEC 9.2.6）。
 */

function item(
  overrides: Partial<CheckableItem> & { id: string },
): CheckableItem {
  return {
    contentType: 'INFORMATIONAL',
    primaryKeyword: `k-${overrides.id}`,
    outboundLinkItemIds: [],
    inboundLinkItemIds: [],
    plannedPublishWeek: null,
    ...overrides,
  };
}

/** 案件1件（収益3本＝AFFILIATE 2 + COMPARISON 1）の通る構成 */
function healthyPlan(): CheckableItem[] {
  const trafficIds = ['t1', 't2', 't3', 't4', 't5', 't6'];

  return [
    item({
      id: 'rev-1',
      contentType: 'AFFILIATE',
      inboundLinkItemIds: ['t1', 't2', 't3'],
    }),
    item({
      id: 'rev-2',
      contentType: 'AFFILIATE',
      inboundLinkItemIds: ['t4', 't5', 't6'],
    }),
    item({ id: 'cmp-1', contentType: 'COMPARISON' }),
    ...trafficIds.map((id, index) =>
      item({
        id,
        outboundLinkItemIds: [index < 3 ? 'rev-1' : 'rev-2'],
      }),
    ),
  ];
}

function check(items: CheckableItem[], adoptedOfferCount = 1) {
  return checkConstraints({ items, adoptedOfferCount });
}

describe('通る構成', () => {
  it('全項目を満たせば合格', () => {
    const result = check(healthyPlan());

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  /** 通っても数えた結果は残す（後から実測を辿るため） */
  it('件数は合格でも残る', () => {
    const result = check(healthyPlan());

    expect(result.counts).toEqual({ total: 9, revenue: 3, traffic: 6 });
  });
});

describe('SPEC 9.2.6 の各項目', () => {
  it('記事総数が30本を超えたら不合格', () => {
    const items = [
      ...healthyPlan(),
      ...Array.from({ length: TOTAL_ARTICLE_MAX }, (_, index) =>
        item({ id: `extra-${index}` }),
      ),
    ];

    const result = check(items);

    expect(result.passed).toBe(false);
    expect(result.violations.map((entry) => entry.code)).toContain(
      CONSTRAINT_CODES.totalExceeded,
    );
  });

  /** 収益記事数 ＝ 採用案件数 × 2 ＋ 1。**比較記事を含めて数える** */
  it('収益記事数が式と合わなければ不合格', () => {
    const result = check(healthyPlan(), 2);

    expect(result.passed).toBe(false);
    expect(result.violations.map((entry) => entry.code)).toContain(
      CONSTRAINT_CODES.revenueCountMismatch,
    );
  });

  it('流入が3本に満たなければ不合格', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 'rev-1'
        ? { ...entry, inboundLinkItemIds: ['t1', 't2'] }
        : entry,
    );

    const result = check(items);
    const violation = result.violations.find(
      (entry) => entry.code === CONSTRAINT_CODES.inboundTooFew,
    );

    expect(violation?.itemIds).toEqual(['rev-1']);
    expect(INBOUND_MIN).toBe(3);
  });

  /** **比較記事は流入3本の対象外**（リンク先にならない。E-7） */
  it('比較記事の流入は数えない', () => {
    const result = check(healthyPlan());

    expect(result.passed).toBe(true);
  });

  it('リンクが2本を超えたら不合格', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 't1'
        ? { ...entry, outboundLinkItemIds: ['rev-1', 'rev-2', 'rev-1'] }
        : entry,
    );

    const result = check(items);

    expect(result.violations.map((entry) => entry.code)).toContain(
      CONSTRAINT_CODES.outboundTooMany,
    );
    expect(OUTBOUND_MAX).toBe(2);
  });

  it('キーワードが重複したら不合格', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 't1' || entry.id === 't2'
        ? { ...entry, primaryKeyword: '同じ語' }
        : entry,
    );

    const violation = check(items).violations.find(
      (entry) => entry.code === CONSTRAINT_CODES.keywordDuplicated,
    );

    expect(violation?.itemIds.sort()).toEqual(['t1', 't2']);
  });

  /** 表記の揺れも重複として見る（STEP 4 と同じ正規化） */
  it('全角と半角の違いだけでも重複', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 't1'
        ? { ...entry, primaryKeyword: 'ＶＯＤ　比較' }
        : entry.id === 't2'
          ? { ...entry, primaryKeyword: 'vod 比較' }
          : entry,
    );

    expect(check(items).passed).toBe(false);
  });

  it('リンク先が AFFILIATE 以外なら不合格', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 't1' ? { ...entry, outboundLinkItemIds: ['cmp-1'] } : entry,
    );

    const violation = check(items).violations.find(
      (entry) => entry.code === CONSTRAINT_CODES.outboundNotAffiliate,
    );

    expect(violation?.itemIds).toEqual(['t1']);
  });

  /** DATA_MODEL 4章の2 */
  it('収益記事がリンクを持ったら不合格', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 'rev-1'
        ? { ...entry, outboundLinkItemIds: ['rev-2'] }
        : entry,
    );

    const violation = check(items).violations.find(
      (entry) => entry.code === CONSTRAINT_CODES.revenueHasOutbound,
    );

    expect(violation?.itemIds).toEqual(['rev-1']);
  });

  /** SPEC 2.2「週4本を超えて公開する処理を実装してはならない」 */
  it('1週に5本以上なら不合格', () => {
    const items = healthyPlan().map((entry, index) =>
      index < WEEKLY_PUBLISH_CAP + 1
        ? { ...entry, plannedPublishWeek: 1 }
        : entry,
    );

    expect(check(items).violations.map((entry) => entry.code)).toContain(
      CONSTRAINT_CODES.weeklyCapExceeded,
    );
  });

  /** **未割り当ては数えない**（公開週を付けるのは E-9） */
  it('公開週が未割り当てなら週の判定をしない', () => {
    expect(check(healthyPlan()).passed).toBe(true);
  });
});

describe('不合格の返し方', () => {
  /** **1つでも欠ければ不合格。**「だいたい通っている」を返さない */
  it('違反が1つでもあれば passed は false', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 'rev-1' ? { ...entry, inboundLinkItemIds: [] } : entry,
    );

    expect(check(items).passed).toBe(false);
  });

  it('違反は重ねて返す', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 'rev-1'
        ? { ...entry, inboundLinkItemIds: [], outboundLinkItemIds: ['rev-2'] }
        : entry,
    );

    expect(check(items).violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('やり直しの手がかり', () => {
  /** **全体を作り直させない。** 不足している記事のIDだけを渡す */
  it('流入が足りない記事のIDを返す', () => {
    const items = healthyPlan().map((entry) =>
      entry.id === 'rev-1' ? { ...entry, inboundLinkItemIds: [] } : entry,
    );

    const hints = buildRepairHints(check(items));

    expect(hints.needsInbound).toEqual(['rev-1']);
    expect(hints.needsKeyword).toEqual([]);
  });

  it('合格なら手がかりは空', () => {
    const hints = buildRepairHints(check(healthyPlan()));

    expect(hints).toEqual({ needsInbound: [], needsKeyword: [] });
  });
});
