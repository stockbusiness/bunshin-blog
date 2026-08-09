/**
 * STEP 3 収益記事の設計（TASKS E-6、SPEC 9.2.4、CONTENT_PLANNING 4.1）。
 *
 * ## 種類と本数はコードが決める
 *
 * > 記事の**種類と本数はコードが決め、AIはタイトルと検索意図の文言のみ**を
 * > 作る（CONTENT_PLANNING 4.1）
 *
 * ```
 * 記事数 = min(採用案件数 × 2 + 1, 10)
 * 案件ごとに「口コミ・評判」「料金・解約」の2本、全体で「比較」1本
 * ```
 *
 * AIに渡すのは**枠（slot）の一覧**で、AIは枠ごとにタイトルを付けて返す。
 * 枠を増やしたり減らしたりさせない — 返ってきた件数と `slotId` を
 * コードで突き合わせる（CONTENT_PLANNING 4.2）。
 *
 * DBも外部も触らない純粋な処理。
 */

import { invalidStep3InputError } from './errors';

/** 収益記事の上限（SPEC 9.2.4「上限10本」） */
export const REVENUE_ARTICLE_MAX = 10;

/** 記事の型。案件ごとに2本＋全体で1本 */
export type RevenuePattern = 'REVIEW' | 'PRICING' | 'COMPARISON';

export const REVENUE_PATTERN_LABELS: Readonly<Record<RevenuePattern, string>> =
  {
    REVIEW: '口コミ・評判',
    PRICING: '料金・解約',
    COMPARISON: '比較',
  };

/** 案件ごとに作る記事の型（SPEC 9.2.4） */
const PER_OFFER_PATTERNS: readonly RevenuePattern[] = ['REVIEW', 'PRICING'];

export interface AdoptedOffer {
  offerId: string;
  offerName: string;
  /** 記事生成の事実制約（SPEC 9.5.3）。ここではAIへ渡すだけ */
  facts: unknown;
}

/** AIへ渡す枠。**AIはここに文言を付けるだけ** */
export interface RevenueSlot {
  slotId: string;
  pattern: RevenuePattern;
  /** 比較記事は特定の案件に紐づかない */
  offerId: string | null;
  offerName: string;
  facts: unknown;
}

/**
 * 枠を組み立てる。
 *
 * **比較記事を必ず残す。** 上限に掛かったときは案件ごとの記事から削る —
 * 比較は全体で1本しかなく、落とすと構成そのものが変わる。
 *
 * @throws {AppError} 採用案件が無い（STEP 2 が0件なら STEP 1 へ差し戻す）
 */
export function planRevenueSlots(
  offers: readonly AdoptedOffer[],
): RevenueSlot[] {
  if (offers.length === 0) {
    throw invalidStep3InputError(
      '採用された案件がありません。STEP 2 をやり直してください',
    );
  }

  const perOffer: RevenueSlot[] = [];

  for (const offer of offers) {
    for (const pattern of PER_OFFER_PATTERNS) {
      perOffer.push({
        slotId: `${offer.offerId}:${pattern}`,
        pattern,
        offerId: offer.offerId,
        offerName: offer.offerName,
        facts: offer.facts,
      });
    }
  }

  // 比較記事の1本ぶんを空けてから詰める
  const kept = perOffer.slice(0, REVENUE_ARTICLE_MAX - 1);

  return [
    ...kept,
    {
      slotId: 'comparison',
      pattern: 'COMPARISON',
      offerId: null,
      // 比較記事は採用案件をまとめて扱う
      offerName: offers.map((offer) => offer.offerName).join('・'),
      facts: offers.map((offer) => offer.facts),
    },
  ];
}

/** 記事数（SPEC 9.2.4 の式そのもの） */
export function revenueArticleCount(offerCount: number): number {
  return Math.min(offerCount * 2 + 1, REVENUE_ARTICLE_MAX);
}

/** AIが返す1件（CONTENT_PLANNING 4.2） */
export interface RevenueTitle {
  slotId: string;
  title: string;
  primaryKeyword: string;
  searchIntent: string;
}

export interface PlannedRevenueItem extends RevenueSlot {
  title: string;
  primaryKeyword: string;
  searchIntent: string;
}

/**
 * AIの出力を枠へ突き合わせる（CONTENT_PLANNING 4.2 の検証）。
 *
 * **件数と `slotId` の一致を要求する。** 一致を確かめずに保存すると、
 * AIが枠を増やしたり減らしたりした構成表がそのまま通る。
 *
 * **同じ `primary_keyword` を許さない。** ブログ内で重複すると、
 * 自分の記事どうしで検索結果を食い合う（SPEC 9.2.5、DATA_MODEL 4章の5）。
 *
 * @throws {AppError} 件数・`slotId`・キーワードのいずれかが合わない
 */
export function matchRevenueTitles(
  slots: readonly RevenueSlot[],
  titles: readonly RevenueTitle[],
): PlannedRevenueItem[] {
  if (titles.length !== slots.length) {
    throw invalidStep3InputError(
      `記事の件数が合いません（枠${slots.length}件に対し${titles.length}件）`,
    );
  }

  const bySlotId = new Map(titles.map((title) => [title.slotId, title]));
  const keywords = new Set<string>();

  return slots.map((slot) => {
    const title = bySlotId.get(slot.slotId);

    if (title === undefined) {
      throw invalidStep3InputError(
        `枠 ${slot.slotId} に対する記事がありません`,
      );
    }

    const primaryKeyword = title.primaryKeyword.trim();

    if (primaryKeyword === '') {
      throw invalidStep3InputError(`枠 ${slot.slotId} のキーワードが空です`);
    }

    const normalized = primaryKeyword.toLowerCase();

    if (keywords.has(normalized)) {
      throw invalidStep3InputError(
        `キーワード「${primaryKeyword}」が重複しています`,
      );
    }

    keywords.add(normalized);

    return {
      ...slot,
      title: title.title.trim(),
      primaryKeyword,
      searchIntent: title.searchIntent.trim(),
    };
  });
}
