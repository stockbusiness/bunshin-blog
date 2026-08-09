/**
 * STEP 4 集客記事とリンク設計の判定（TASKS E-7、SPEC 9.2.5、
 * CONTENT_PLANNING 5.3・5.5）。
 *
 * ## リンク先は `AFFILIATE` の記事だけ
 *
 * > **`outbound_link_item_ids` に `contentType !== "AFFILIATE"` のIDが
 * > 入っていないことを、保存直前に必ず検査する。手作業での検証では
 * > 30本中9本でこの誤りが発生した**（CONTENT_PLANNING 5.5）
 *
 * これが E-7 の完了条件。**保存の直前で見る** — 組み立ての途中で
 * 確かめても、あとから足された分をすり抜ける。
 *
 * **比較記事（`COMPARISON`）もリンク先にできない。** 収益記事ではあるが
 * 種別が `AFFILIATE` ではないため、規則をそのまま適用する。例外を作ると
 * 「どの種別なら許されるのか」を各所で判断することになる。
 *
 * ## キーワードの重複はコードで見る
 *
 * > `existingKeywords` を渡しても重複は出る。**必ずコード側で正規化して
 * > 突合する**（CONTENT_PLANNING 5.3）
 *
 * DBも外部も触らない純粋な処理。
 */

import { invalidStep4InputError } from './errors';

/** 1本の集客記事が持てるリンクの上限（DATA_MODEL 4章の3） */
export const OUTBOUND_LINK_MAX = 2;

/** 収益記事1本に要る集客記事の本数（SPEC 9.2.6。判定は E-8） */
export const INBOUND_LINK_MIN = 3;

export type ContentType =
  'INFORMATIONAL' | 'EXPERIENCE' | 'FAQ' | 'COMPARISON' | 'AFFILIATE';

/**
 * キーワードを正規化する（CONTENT_PLANNING 5.3 の実装をそのまま）。
 *
 * 全角と半角、空白の揺れ、大小文字を吸収する。**これを通さずに
 * 突合すると「ＶＯＤ 比較」と「vod 比較」が別物になる。**
 */
export function normalizeKeyword(keyword: string): string {
  return keyword
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface KeywordCandidate {
  /** どの検索意図から来たか */
  intentId: string;
  title: string;
  primaryKeyword: string;
  contentType: ContentType;
}

export interface KeywordConflict {
  intentId: string;
  keyword: string;
}

/**
 * 重複したキーワードを見つける。
 *
 * **既存との重複と、候補どうしの重複の両方を見る。** AIへ
 * `existingKeywords` を渡しても、返ってきた候補どうしがぶつかることがある。
 *
 * 先に出たほうを残し、後から来たほうを衝突として返す（差し替えの対象）。
 */
export function findKeywordConflicts(
  candidates: readonly KeywordCandidate[],
  existingKeywords: readonly string[],
): KeywordConflict[] {
  const seen = new Set(existingKeywords.map(normalizeKeyword));
  const conflicts: KeywordConflict[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeKeyword(candidate.primaryKeyword);

    if (normalized === '') {
      conflicts.push({
        intentId: candidate.intentId,
        keyword: candidate.primaryKeyword,
      });
      continue;
    }

    if (seen.has(normalized)) {
      conflicts.push({
        intentId: candidate.intentId,
        keyword: candidate.primaryKeyword,
      });
      continue;
    }

    seen.add(normalized);
  }

  return conflicts;
}

/**
 * 差し替え案を当てる。
 *
 * **差し替えても重複が残る場合はその候補を落とす。** 通すと、
 * 保存時にブログ内で同じキーワードの記事が2本できる。
 */
export function applyKeywordRepairs(
  candidates: readonly KeywordCandidate[],
  repairs: readonly {
    intentId: string;
    title: string;
    primaryKeyword: string;
  }[],
  existingKeywords: readonly string[],
): KeywordCandidate[] {
  const byIntentId = new Map(
    repairs.map((repair) => [repair.intentId, repair]),
  );
  const seen = new Set(existingKeywords.map(normalizeKeyword));
  const kept: KeywordCandidate[] = [];

  for (const candidate of candidates) {
    const repair = byIntentId.get(candidate.intentId);
    const applied =
      repair === undefined
        ? candidate
        : {
            ...candidate,
            title: repair.title,
            primaryKeyword: repair.primaryKeyword,
          };

    const normalized = normalizeKeyword(applied.primaryKeyword);

    if (normalized === '' || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    kept.push(applied);
  }

  return kept;
}

export interface LinkableItem {
  id: string;
  contentType: ContentType;
}

export interface TrafficItemDraft {
  /** どの収益記事へ繋ぐか。**`AFFILIATE` の記事のみ** */
  targetRevenueItemId: string;
  title: string;
  primaryKeyword: string;
  searchIntent: string;
  contentType: ContentType;
}

export interface LinkAssignment {
  /** 集客記事のリンク先（`outbound_link_item_ids`） */
  outboundByTraffic: Map<number, string[]>;
  /** 収益記事の被リンク（`inbound_link_item_ids`） */
  inboundByRevenue: Map<string, string[]>;
}

/**
 * リンク先が `AFFILIATE` の記事だけであることを確かめる（**完了条件**）。
 *
 * **保存の直前に呼ぶ。** 組み立ての途中で確かめても、あとから足された分を
 * すり抜ける（CONTENT_PLANNING 5.5）。
 *
 * @throws {AppError} `AFFILIATE` 以外・存在しないIDが混ざっている
 */
export function assertOutboundAreAffiliate(
  outboundIds: readonly string[],
  items: readonly LinkableItem[],
): void {
  const byId = new Map(items.map((item) => [item.id, item]));

  for (const id of outboundIds) {
    const item = byId.get(id);

    if (item === undefined) {
      throw invalidStep4InputError(`リンク先 ${id} が構成表にありません`);
    }

    if (item.contentType !== 'AFFILIATE') {
      throw invalidStep4InputError(
        `リンク先 ${id} は ${item.contentType} です。収益記事（AFFILIATE）以外へ繋げません`,
      );
    }
  }
}

/**
 * リンクを割り当てる（CONTENT_PLANNING 5.5）。
 *
 * - 集客記事は由来した収益記事を `outbound` に持つ（最大2件）
 * - 収益記事の `inbound` は、それを参照する集客記事の集合
 * - **収益記事の `outbound` は空**（DATA_MODEL 4章の2）
 *
 * `trafficIds` は保存後に決まるため、添字で受け取って添字で返す。
 */
export function assignLinks(params: {
  drafts: readonly TrafficItemDraft[];
  trafficIds: readonly string[];
}): LinkAssignment {
  const outboundByTraffic = new Map<number, string[]>();
  const inboundByRevenue = new Map<string, string[]>();

  params.drafts.forEach((draft, index) => {
    const trafficId = params.trafficIds[index];

    if (trafficId === undefined) {
      throw invalidStep4InputError('集客記事の件数とIDの件数が合いません');
    }

    outboundByTraffic.set(
      index,
      [draft.targetRevenueItemId].slice(0, OUTBOUND_LINK_MAX),
    );

    const current = inboundByRevenue.get(draft.targetRevenueItemId) ?? [];
    current.push(trafficId);
    inboundByRevenue.set(draft.targetRevenueItemId, current);
  });

  return { outboundByTraffic, inboundByRevenue };
}

/**
 * 収益記事ごとの被リンク数（SPEC 9.2.6 の3本以上）。
 *
 * **判定そのものは E-8。** ここでは数えるだけ — 不足していても
 * この段では落とさず、追加の集客記事を割り当てる余地を残す。
 *
 * **`AFFILIATE` の記事だけを数える。** 比較記事はリンク先にできないため、
 * 3本以上の対象にならない。
 */
export function countInboundPerRevenue(
  items: readonly LinkableItem[],
  inboundByRevenue: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    if (item.contentType !== 'AFFILIATE') {
      continue;
    }

    counts.set(item.id, inboundByRevenue.get(item.id)?.length ?? 0);
  }

  return counts;
}
