import { describe, expect, it } from 'vitest';
import {
  INBOUND_LINK_MIN,
  OUTBOUND_LINK_MAX,
  PLANNING_ERROR_CODES,
  applyKeywordRepairs,
  assertOutboundAreAffiliate,
  assignLinks,
  countInboundPerRevenue,
  findKeywordConflicts,
  normalizeKeyword,
  type KeywordCandidate,
  type LinkableItem,
  type TrafficItemDraft,
} from '@/modules/content-planning';

/**
 * STEP 4 のキーワード突合とリンク割り当て（TASKS E-7、SPEC 9.2.5）。
 *
 * 完了条件「**リンク先に `AFFILIATE` 以外を指定できない**」。
 *
 * DBもAIも触らない純粋な処理。
 */

function candidate(
  intentId: string,
  primaryKeyword: string,
  contentType: KeywordCandidate['contentType'] = 'INFORMATIONAL',
): KeywordCandidate {
  return { intentId, title: `記事 ${intentId}`, primaryKeyword, contentType };
}

describe('キーワードの正規化（CONTENT_PLANNING 5.3）', () => {
  it.each([
    ['ＶＯＤ　比較', 'vod 比較'],
    ['  VOD   比較  ', 'vod 比較'],
    ['VOD比較', 'vod比較'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeKeyword(input)).toBe(expected);
  });

  /** **これを通さずに突合すると別物として通る** */
  it('全角と半角の違いを吸収する', () => {
    expect(normalizeKeyword('ＶＯＤ　比較')).toBe(normalizeKeyword('vod 比較'));
  });
});

describe('重複の検出', () => {
  it('既存と重なれば衝突', () => {
    const conflicts = findKeywordConflicts(
      [candidate('i1', 'VOD 比較')],
      ['ＶＯＤ　比較'],
    );

    expect(conflicts.map((entry) => entry.intentId)).toEqual(['i1']);
  });

  /** **`existingKeywords` を渡しても、候補どうしがぶつかる** */
  it('候補どうしの重複も見る', () => {
    const conflicts = findKeywordConflicts(
      [candidate('i1', '動画 見放題'), candidate('i2', '動画　見放題')],
      [],
    );

    expect(conflicts.map((entry) => entry.intentId)).toEqual(['i2']);
  });

  it('空のキーワードも衝突として扱う', () => {
    expect(findKeywordConflicts([candidate('i1', '  ')], [])).toHaveLength(1);
  });

  it('重ならなければ空', () => {
    expect(
      findKeywordConflicts([candidate('i1', 'A'), candidate('i2', 'B')], ['C']),
    ).toEqual([]);
  });
});

describe('差し替えの適用', () => {
  it('差し替え案を当てる', () => {
    const result = applyKeywordRepairs(
      [candidate('i1', '重複語')],
      [{ intentId: 'i1', title: '新タイトル', primaryKeyword: '別の語' }],
      ['重複語'],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.primaryKeyword).toBe('別の語');
    expect(result[0]?.title).toBe('新タイトル');
  });

  /** **差し替えても重複が残る候補は落とす。** 通すと同じ語の記事が2本できる */
  it('差し替えても重なる候補は落とす', () => {
    const result = applyKeywordRepairs(
      [candidate('i1', '重複語')],
      [{ intentId: 'i1', title: 'x', primaryKeyword: 'まだ重複' }],
      ['重複語', 'まだ重複'],
    );

    expect(result).toEqual([]);
  });

  it('差し替え案が無い候補はそのまま残る', () => {
    const result = applyKeywordRepairs([candidate('i1', '無事な語')], [], []);

    expect(result).toHaveLength(1);
  });

  it('差し替え後どうしの重複も落とす', () => {
    const result = applyKeywordRepairs(
      [candidate('i1', 'a'), candidate('i2', 'b')],
      [
        { intentId: 'i1', title: 'x', primaryKeyword: '同じ' },
        { intentId: 'i2', title: 'y', primaryKeyword: '同じ' },
      ],
      [],
    );

    expect(result).toHaveLength(1);
  });
});

describe('リンク先は AFFILIATE だけ（完了条件）', () => {
  const items: LinkableItem[] = [
    { id: 'rev-1', contentType: 'AFFILIATE' },
    { id: 'cmp-1', contentType: 'COMPARISON' },
    { id: 'traffic-1', contentType: 'INFORMATIONAL' },
  ];

  it('AFFILIATE への参照は通る', () => {
    expect(() => assertOutboundAreAffiliate(['rev-1'], items)).not.toThrow();
  });

  /**
   * **比較記事もリンク先にできない。** 収益記事ではあるが種別が
   * `AFFILIATE` ではないため、規則をそのまま適用する。
   */
  it('COMPARISON への参照は落とす', () => {
    expect(() => assertOutboundAreAffiliate(['cmp-1'], items)).toThrowError(
      expect.objectContaining({
        code: PLANNING_ERROR_CODES.invalidStep4Input,
        status: 422,
      }),
    );
  });

  it('集客記事への参照は落とす', () => {
    expect(() => assertOutboundAreAffiliate(['traffic-1'], items)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep4Input }),
    );
  });

  it('構成表に無いIDは落とす', () => {
    expect(() =>
      assertOutboundAreAffiliate(['知らないID'], items),
    ).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep4Input }),
    );
  });

  it('1つでも混ざれば落とす', () => {
    expect(() =>
      assertOutboundAreAffiliate(['rev-1', 'cmp-1'], items),
    ).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep4Input }),
    );
  });
});

describe('リンクの割り当て（CONTENT_PLANNING 5.5）', () => {
  function draft(targetRevenueItemId: string): TrafficItemDraft {
    return {
      targetRevenueItemId,
      title: 'タイトル',
      primaryKeyword: `k-${targetRevenueItemId}-${Math.random()}`,
      searchIntent: '意図',
      contentType: 'INFORMATIONAL',
    };
  }

  it('集客記事は由来した収益記事を持つ', () => {
    const result = assignLinks({
      drafts: [draft('rev-1'), draft('rev-2')],
      trafficIds: ['t1', 't2'],
    });

    expect(result.outboundByTraffic.get(0)).toEqual(['rev-1']);
    expect(result.outboundByTraffic.get(1)).toEqual(['rev-2']);
  });

  it('収益記事の被リンクは参照した集客記事の集合', () => {
    const result = assignLinks({
      drafts: [draft('rev-1'), draft('rev-1'), draft('rev-2')],
      trafficIds: ['t1', 't2', 't3'],
    });

    expect(result.inboundByRevenue.get('rev-1')).toEqual(['t1', 't2']);
    expect(result.inboundByRevenue.get('rev-2')).toEqual(['t3']);
  });

  it('リンクは最大2件（DATA_MODEL 4章の3）', () => {
    const result = assignLinks({
      drafts: [draft('rev-1')],
      trafficIds: ['t1'],
    });

    expect(result.outboundByTraffic.get(0)?.length).toBeLessThanOrEqual(
      OUTBOUND_LINK_MAX,
    );
  });

  it('IDの件数が合わなければ落とす', () => {
    expect(() =>
      assignLinks({ drafts: [draft('rev-1')], trafficIds: [] }),
    ).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep4Input }),
    );
  });
});

describe('被リンク数の集計', () => {
  const items: LinkableItem[] = [
    { id: 'rev-1', contentType: 'AFFILIATE' },
    { id: 'rev-2', contentType: 'AFFILIATE' },
    { id: 'cmp-1', contentType: 'COMPARISON' },
  ];

  it('AFFILIATE だけを数える', () => {
    const counts = countInboundPerRevenue(
      items,
      new Map([
        ['rev-1', ['t1', 't2', 't3']],
        ['cmp-1', ['t4']],
      ]),
    );

    expect(counts.get('rev-1')).toBe(INBOUND_LINK_MIN);
    expect(counts.get('rev-2')).toBe(0);
    // **比較記事はリンク先にならないので、3本以上の対象外**
    expect(counts.has('cmp-1')).toBe(false);
  });
});
