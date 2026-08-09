/**
 * 制約チェック（TASKS E-8、SPEC 9.2.6、DATA_MODEL 4章）。
 *
 * ## 判定はすべてここ
 *
 * DATA_MODEL 4章が「`modules/content-planning/constraints.ts` に集約し、
 * **DBに書く前に必ず通す**」と定めている場所。**AIの出力を受け取らない。**
 *
 * ## 通らない構成表を承認依頼へ送らない
 *
 * > 最大3回で収束しない場合はジョブを `FAILED` とし、ADMINへ通知する。
 * > **暫定的な構成表を承認依頼へ送ってはならない**（SPEC 9.2.6）
 *
 * だから「だいたい通っている」を返さない。**1つでも欠ければ不合格。**
 *
 * DBも外部も触らない純粋な処理。
 */

import { normalizeKeyword, type ContentType } from './step4';

/** 記事総数の上限（SPEC 9.2.6） */
export const TOTAL_ARTICLE_MAX = 30;

/** 収益記事1本に要る流入（SPEC 9.2.6） */
export const INBOUND_MIN = 3;

/** 1集客記事が持てるリンク（SPEC 9.2.6） */
export const OUTBOUND_MAX = 2;

/** 1週あたりの公開上限（SPEC 2.2。判定はここ、割り当ては E-9） */
export const WEEKLY_PUBLISH_CAP = 4;

/** 違反の種類。`planning_runs.constraint_result` に入る */
export const CONSTRAINT_CODES = {
  /** 記事が30本を超えた */
  totalExceeded: 'total_exceeded',
  /** 収益記事数が「採用案件数×2＋1」と合わない */
  revenueCountMismatch: 'revenue_count_mismatch',
  /** 流入が3本に満たない収益記事がある */
  inboundTooFew: 'inbound_too_few',
  /** リンクが2本を超える集客記事がある */
  outboundTooMany: 'outbound_too_many',
  /** キーワードが重複している */
  keywordDuplicated: 'keyword_duplicated',
  /** リンク先に `AFFILIATE` 以外が混ざっている */
  outboundNotAffiliate: 'outbound_not_affiliate',
  /** 収益記事がリンクを持っている */
  revenueHasOutbound: 'revenue_has_outbound',
  /** 1週に5本以上が割り当てられている */
  weeklyCapExceeded: 'weekly_cap_exceeded',
} as const;

export type ConstraintCode =
  (typeof CONSTRAINT_CODES)[keyof typeof CONSTRAINT_CODES];

export interface ConstraintViolation {
  code: ConstraintCode;
  /** 直すべき記事のID。全体の違反なら空 */
  itemIds: string[];
  /** 画面とログへ出す説明 */
  message: string;
}

export interface ConstraintResult {
  passed: boolean;
  violations: ConstraintViolation[];
  /** 数えた結果。**通っても残す**（後から実測を辿るため） */
  counts: {
    total: number;
    revenue: number;
    traffic: number;
  };
}

export interface CheckableItem {
  id: string;
  contentType: ContentType;
  primaryKeyword: string | null;
  outboundLinkItemIds: readonly string[];
  inboundLinkItemIds: readonly string[];
  plannedPublishWeek: number | null;
}

function violation(
  code: ConstraintCode,
  message: string,
  itemIds: string[] = [],
): ConstraintViolation {
  return { code, itemIds, message };
}

/**
 * 構成表を判定する（SPEC 9.2.6 の全項目）。
 *
 * **`adoptedOfferCount` を渡す。** 収益記事数の式（案件数×2＋1）は
 * 記事だけからは確かめられない。
 *
 * @param items 構成表の全記事（収益・集客の両方）
 */
export function checkConstraints(params: {
  items: readonly CheckableItem[];
  adoptedOfferCount: number;
}): ConstraintResult {
  const { items } = params;
  const violations: ConstraintViolation[] = [];

  const revenue = items.filter((item) => item.contentType === 'AFFILIATE');
  const comparison = items.filter((item) => item.contentType === 'COMPARISON');
  const traffic = items.filter(
    (item) =>
      item.contentType !== 'AFFILIATE' && item.contentType !== 'COMPARISON',
  );

  // 1. 記事総数 30
  if (items.length > TOTAL_ARTICLE_MAX) {
    violations.push(
      violation(
        CONSTRAINT_CODES.totalExceeded,
        `記事が${items.length}本あります（上限${TOTAL_ARTICLE_MAX}本）`,
      ),
    );
  }

  // 2. 収益記事数 ＝ 採用案件数 × 2 ＋ 1
  //    **比較記事を含めて数える**（式の「＋1」が比較記事）
  const revenueTotal = revenue.length + comparison.length;
  const expected = params.adoptedOfferCount * 2 + 1;

  if (revenueTotal !== expected) {
    violations.push(
      violation(
        CONSTRAINT_CODES.revenueCountMismatch,
        `収益記事が${revenueTotal}本です（採用${params.adoptedOfferCount}件なら${expected}本）`,
      ),
    );
  }

  // 3. 各収益記事への流入 3本以上
  //    **`AFFILIATE` だけを見る。** 比較記事はリンク先にならない（E-7）
  const underLinked = revenue.filter(
    (item) => item.inboundLinkItemIds.length < INBOUND_MIN,
  );

  if (underLinked.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.inboundTooFew,
        `流入が${INBOUND_MIN}本に満たない収益記事が${underLinked.length}本あります`,
        underLinked.map((item) => item.id),
      ),
    );
  }

  // 4. 1集客記事のリンク先 2本以下
  const overLinked = items.filter(
    (item) => item.outboundLinkItemIds.length > OUTBOUND_MAX,
  );

  if (overLinked.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.outboundTooMany,
        `リンクが${OUTBOUND_MAX}本を超える記事が${overLinked.length}本あります`,
        overLinked.map((item) => item.id),
      ),
    );
  }

  // 5. キーワード重複 0
  const byKeyword = new Map<string, string[]>();

  for (const item of items) {
    if (item.primaryKeyword === null) {
      continue;
    }

    const normalized = normalizeKeyword(item.primaryKeyword);

    if (normalized === '') {
      continue;
    }

    byKeyword.set(normalized, [...(byKeyword.get(normalized) ?? []), item.id]);
  }

  const duplicated = [...byKeyword.values()].filter((ids) => ids.length > 1);

  if (duplicated.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.keywordDuplicated,
        `キーワードが重複している記事が${duplicated.flat().length}本あります`,
        duplicated.flat(),
      ),
    );
  }

  // 6. リンク先の記事種別 `AFFILIATE` のみ
  const byId = new Map(items.map((item) => [item.id, item]));
  const wrongTarget = items.filter((item) =>
    item.outboundLinkItemIds.some(
      (id) => byId.get(id)?.contentType !== 'AFFILIATE',
    ),
  );

  if (wrongTarget.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.outboundNotAffiliate,
        `収益記事以外へリンクしている記事が${wrongTarget.length}本あります`,
        wrongTarget.map((item) => item.id),
      ),
    );
  }

  // 7. 収益記事はリンクを持たない（DATA_MODEL 4章の2）
  const revenueWithOutbound = [...revenue, ...comparison].filter(
    (item) => item.outboundLinkItemIds.length > 0,
  );

  if (revenueWithOutbound.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.revenueHasOutbound,
        `リンクを持つ収益記事が${revenueWithOutbound.length}本あります`,
        revenueWithOutbound.map((item) => item.id),
      ),
    );
  }

  // 8. 1週あたり4本以下（SPEC 2.2）。**未割り当ては数えない**（E-9 が付ける）
  const perWeek = new Map<number, number>();

  for (const item of items) {
    if (item.plannedPublishWeek === null) {
      continue;
    }

    perWeek.set(
      item.plannedPublishWeek,
      (perWeek.get(item.plannedPublishWeek) ?? 0) + 1,
    );
  }

  const overCapWeeks = [...perWeek.entries()].filter(
    ([, count]) => count > WEEKLY_PUBLISH_CAP,
  );

  if (overCapWeeks.length > 0) {
    violations.push(
      violation(
        CONSTRAINT_CODES.weeklyCapExceeded,
        `週${WEEKLY_PUBLISH_CAP}本を超える週が${overCapWeeks.length}つあります`,
      ),
    );
  }

  return {
    // **1つでも欠ければ不合格。** 「だいたい通っている」を返さない
    passed: violations.length === 0,
    violations,
    counts: {
      total: items.length,
      revenue: revenueTotal,
      traffic: traffic.length,
    },
  };
}

/**
 * 次の試行へ渡す手がかり（CONTENT_PLANNING 6 の `applyRepairHints`）。
 *
 * **全体を作り直させない。** 不足している収益記事のIDだけを渡し、
 * そこへの流入を足させる。作り直すと、通っていた記事まで変わる。
 */
export interface RepairHints {
  /** 流入が足りない収益記事 */
  needsInbound: string[];
  /** 重複したキーワードを持つ記事 */
  needsKeyword: string[];
}

export function buildRepairHints(result: ConstraintResult): RepairHints {
  const find = (code: ConstraintCode): string[] =>
    result.violations.find((entry) => entry.code === code)?.itemIds ?? [];

  return {
    needsInbound: find(CONSTRAINT_CODES.inboundTooFew),
    needsKeyword: find(CONSTRAINT_CODES.keywordDuplicated),
  };
}
