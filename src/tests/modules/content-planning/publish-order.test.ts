import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_WEEKLY_CAP,
  PLANNING_ERROR_CODES,
  REVENUE_WEEKS,
  assignPublishOrder,
  revenueFitsInInitialWeeks,
  type OrderableItem,
} from '@/modules/content-planning';

/**
 * 公開順序（TASKS E-9、SPEC 9.2.7・2.2）。
 *
 * 完了条件「**収益記事が先行し、集客記事が週4本を超えない**」。
 *
 * DBもAIも触らない純粋な処理。
 */

function revenue(id: string, sequenceNo: number): OrderableItem {
  return {
    id,
    contentType: 'AFFILIATE',
    sequenceNo,
    outboundLinkItemIds: [],
  };
}

function traffic(
  id: string,
  sequenceNo: number,
  target: string,
): OrderableItem {
  return {
    id,
    contentType: 'INFORMATIONAL',
    sequenceNo,
    outboundLinkItemIds: [target],
  };
}

/** 収益2本＋比較1本＋集客6本 */
function plan(): OrderableItem[] {
  return [
    revenue('rev-1', 1),
    revenue('rev-2', 2),
    {
      id: 'cmp-1',
      contentType: 'COMPARISON',
      sequenceNo: 3,
      outboundLinkItemIds: [],
    },
    traffic('t1', 4, 'rev-2'),
    traffic('t2', 5, 'rev-1'),
    traffic('t3', 6, 'rev-2'),
    traffic('t4', 7, 'rev-1'),
    traffic('t5', 8, 'rev-1'),
    traffic('t6', 9, 'rev-2'),
  ];
}

describe('収益記事が先行する（完了条件）', () => {
  it('収益記事が先に並ぶ', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 4 });
    const order = slots.map((slot) => slot.itemId);

    expect(order.slice(0, 3)).toEqual(['rev-1', 'rev-2', 'cmp-1']);
  });

  /** 比較記事も収益記事。集客記事より先 */
  it('比較記事も集客記事より先', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 4 });
    const byId = new Map(slots.map((slot) => [slot.itemId, slot]));

    expect(byId.get('cmp-1')?.publishPriority).toBeLessThan(
      byId.get('t1')?.publishPriority ?? 0,
    );
  });

  it('通し番号は1から連番', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 4 });

    expect(slots.map((slot) => slot.publishPriority)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});

describe('週4本を超えない（完了条件）', () => {
  it.each([[1], [2], [3], [4]])('上限%s本を超えない', (weeklyCap) => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap });
    const perWeek = new Map<number, number>();

    for (const slot of slots) {
      perWeek.set(
        slot.plannedPublishWeek,
        (perWeek.get(slot.plannedPublishWeek) ?? 0) + 1,
      );
    }

    for (const count of perWeek.values()) {
      expect(count).toBeLessThanOrEqual(weeklyCap);
    }
  });

  it('週4本なら9本が3週に収まる', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 4 });

    expect(slots.map((slot) => slot.plannedPublishWeek)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 3,
    ]);
  });

  /** SPEC 2.2 の絶対の上限を超える指定は受け付けない */
  it.each([[0], [5], [1.5], [Number.NaN]])(
    '上限 %s は受け付けない',
    (weeklyCap) => {
      expect(() =>
        assignPublishOrder({ items: plan(), weeklyCap }),
      ).toThrowError(
        expect.objectContaining({
          code: PLANNING_ERROR_CODES.invalidPublishOrder,
        }),
      );
    },
  );

  it('絶対の上限は4本', () => {
    expect(ABSOLUTE_WEEKLY_CAP).toBe(4);
  });
});

describe('収益記事に近いものから', () => {
  /** 先に出る収益記事へ流す記事を先に出す（流入が早く効く） */
  it('リンク先の公開順で並ぶ', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 4 });
    const trafficOrder = slots
      .filter((slot) => slot.itemId.startsWith('t'))
      .map((slot) => slot.itemId);

    // rev-1 へ流す t2・t4・t5 が、rev-2 へ流す t1・t3・t6 より先
    expect(trafficOrder).toEqual(['t2', 't4', 't5', 't1', 't3', 't6']);
  });

  /** **同じ収益記事へ流すものは構成表の順。** 呼ぶたびに入れ替わらない */
  it('同じリンク先なら構成表の順', () => {
    const first = assignPublishOrder({ items: plan(), weeklyCap: 4 });
    const second = assignPublishOrder({
      items: [...plan()].reverse(),
      weeklyCap: 4,
    });

    expect(second.map((slot) => slot.itemId)).toEqual(
      first.map((slot) => slot.itemId),
    );
  });

  /** リンク先が無い集客記事は最後（順序が決められない） */
  it('リンク先の無い記事は後ろ', () => {
    const items = [
      ...plan(),
      {
        id: 'orphan',
        contentType: 'FAQ' as const,
        sequenceNo: 10,
        outboundLinkItemIds: [],
      },
    ];

    const slots = assignPublishOrder({ items, weeklyCap: 4 });

    expect(slots.at(-1)?.itemId).toBe('orphan');
  });
});

describe('収益記事が2週に収まるか', () => {
  /** **収まらないことを失敗にしない。** ブログの上限が低ければ起きる */
  it.each([
    [3, 4, true],
    [7, 4, true],
    [9, 4, false],
    [7, 2, false],
    [4, 2, true],
  ])('収益%s本・上限%s本 → %s', (revenueCount, weeklyCap, expected) => {
    expect(revenueFitsInInitialWeeks({ revenueCount, weeklyCap })).toBe(
      expected,
    );
  });

  it('収益に充てる週は2', () => {
    expect(REVENUE_WEEKS).toBe(2);
  });

  /** 収まらなくても**先行の順序は保つ** */
  it('上限が低くても収益記事は先に出る', () => {
    const slots = assignPublishOrder({ items: plan(), weeklyCap: 1 });

    expect(slots.slice(0, 3).map((slot) => slot.itemId)).toEqual([
      'rev-1',
      'rev-2',
      'cmp-1',
    ]);
    expect(slots[2]?.plannedPublishWeek).toBe(3);
  });
});
