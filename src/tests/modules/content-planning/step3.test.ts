import { describe, expect, it } from 'vitest';
import {
  PLANNING_ERROR_CODES,
  REVENUE_ARTICLE_MAX,
  matchRevenueTitles,
  planRevenueSlots,
  revenueArticleCount,
  type AdoptedOffer,
  type RevenueSlot,
  type RevenueTitle,
} from '@/modules/content-planning';

/**
 * STEP 3 の枠の組み立てと突き合わせ（TASKS E-6、SPEC 9.2.4）。
 *
 * 完了条件「**記事数が『案件数×2＋1』で算出される**」。
 *
 * **種類と本数はコードが決め、AIは文言だけを付ける**
 * （CONTENT_PLANNING 4.1）。この関数はAIを呼ばない。
 */

function offer(id: string): AdoptedOffer {
  return { offerId: id, offerName: `案件${id}`, facts: { features: [] } };
}

function titlesFor(slots: readonly RevenueSlot[]): RevenueTitle[] {
  return slots.map((slot, index) => ({
    slotId: slot.slotId,
    title: `タイトル${index}`,
    primaryKeyword: `キーワード${index}`,
    searchIntent: `検索意図${index}`,
  }));
}

describe('記事数（SPEC 9.2.4）', () => {
  it.each([
    [1, 3],
    [2, 5],
    [3, 7],
  ])('採用%s件 → %s本', (offerCount, expected) => {
    expect(revenueArticleCount(offerCount)).toBe(expected);

    const slots = planRevenueSlots(
      Array.from({ length: offerCount }, (_, index) => offer(`o${index}`)),
    );

    expect(slots).toHaveLength(expected);
  });

  it('案件ごとに口コミと料金の2本を作る', () => {
    const slots = planRevenueSlots([offer('a'), offer('b')]);

    expect(slots.map((slot) => slot.pattern)).toEqual([
      'REVIEW',
      'PRICING',
      'REVIEW',
      'PRICING',
      'COMPARISON',
    ]);
  });

  it('比較記事は全体で1本、案件に紐づかない', () => {
    const slots = planRevenueSlots([offer('a'), offer('b')]);
    const comparison = slots.filter((slot) => slot.pattern === 'COMPARISON');

    expect(comparison).toHaveLength(1);
    expect(comparison[0]?.offerId).toBeNull();
  });

  it('案件ごとの枠は案件IDを持つ', () => {
    const slots = planRevenueSlots([offer('a')]);

    expect(slots[0]?.offerId).toBe('a');
    expect(slots[1]?.offerId).toBe('a');
  });

  /**
   * **比較記事を必ず残す。** 上限に掛かったら案件ごとの記事から削る —
   * 比較は全体で1本しかなく、落とすと構成そのものが変わる。
   */
  it('上限10本を超えない。比較記事は残る', () => {
    const slots = planRevenueSlots(
      Array.from({ length: 8 }, (_, index) => offer(`o${index}`)),
    );

    expect(slots).toHaveLength(REVENUE_ARTICLE_MAX);
    expect(slots.at(-1)?.pattern).toBe('COMPARISON');
    expect(revenueArticleCount(8)).toBe(REVENUE_ARTICLE_MAX);
  });

  /** STEP 2 が0件なら STEP 1 へ差し戻す。ここで作らない */
  it('採用案件が無ければ落とす', () => {
    expect(() => planRevenueSlots([])).toThrowError(
      expect.objectContaining({
        code: PLANNING_ERROR_CODES.invalidStep3Input,
        status: 422,
      }),
    );
  });
});

describe('AIの出力との突き合わせ（CONTENT_PLANNING 4.2）', () => {
  const slots = planRevenueSlots([offer('a')]);

  it('件数と slotId が合えば通る', () => {
    const result = matchRevenueTitles(slots, titlesFor(slots));

    expect(result).toHaveLength(slots.length);
    expect(result[0]?.slotId).toBe(slots[0]?.slotId);
    expect(result[0]?.pattern).toBe('REVIEW');
  });

  /** **枠を増減させない。** 確かめずに保存すると、そのまま通る */
  it('件数が多ければ落とす', () => {
    const titles = [
      ...titlesFor(slots),
      {
        slotId: 'extra',
        title: '余分',
        primaryKeyword: 'k',
        searchIntent: 'i',
      },
    ];

    expect(() => matchRevenueTitles(slots, titles)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  it('件数が少なければ落とす', () => {
    expect(() =>
      matchRevenueTitles(slots, titlesFor(slots).slice(1)),
    ).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  it('slotId が違えば落とす', () => {
    const titles = titlesFor(slots).map((title, index) =>
      index === 0 ? { ...title, slotId: '知らない枠' } : title,
    );

    expect(() => matchRevenueTitles(slots, titles)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  it('キーワードが空なら落とす', () => {
    const titles = titlesFor(slots).map((title, index) =>
      index === 0 ? { ...title, primaryKeyword: '  ' } : title,
    );

    expect(() => matchRevenueTitles(slots, titles)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  /**
   * **同じキーワードを許さない**（SPEC 9.2.5、DATA_MODEL 4章の5）。
   * ブログ内で重複すると、自分の記事どうしで検索結果を食い合う。
   */
  it('キーワードが重複したら落とす', () => {
    const titles = titlesFor(slots).map((title) => ({
      ...title,
      primaryKeyword: '同じ語',
    }));

    expect(() => matchRevenueTitles(slots, titles)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  /** 表記の揺れで重複を見逃さない */
  it('大小文字が違うだけの重複も落とす', () => {
    const titles = titlesFor(slots).map((title, index) => ({
      ...title,
      primaryKeyword: index === 0 ? 'VOD 比較' : 'vod 比較',
    }));

    expect(() => matchRevenueTitles(slots, titles)).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep3Input }),
    );
  });

  it('前後の空白を落として保存する', () => {
    const titles = titlesFor(slots).map((title) => ({
      ...title,
      title: `  ${title.title}  `,
      primaryKeyword: `  ${title.primaryKeyword}  `,
    }));

    const result = matchRevenueTitles(slots, titles);

    expect(result[0]?.title).toBe('タイトル0');
    expect(result[0]?.primaryKeyword).toBe('キーワード0');
  });

  /** 並び順はAIの返した順ではなく**枠の順** */
  it('枠の順で返す', () => {
    const shuffled = [...titlesFor(slots)].reverse();
    const result = matchRevenueTitles(slots, shuffled);

    expect(result.map((item) => item.slotId)).toEqual(
      slots.map((slot) => slot.slotId),
    );
  });
});
