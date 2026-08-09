/**
 * STEP 1 ジャンル審査の判定（TASKS E-4、SPEC 9.2.2、CONTENT_PLANNING 2.1）。
 *
 * ## 判定はここだけで行う
 *
 * > **AIに「制約を満たしているか」を判断させてはならない。** AIは案を出す
 * > 係であり、可否を決めるのはコードである（CONTENT_PLANNING 1.1）
 *
 * このファイルはDBも外部も触らない純粋な処理で、**AIの出力を一切受け取らない。**
 * 受け取れる形にしておくと、いつか渡される。
 *
 * ## 取得できないことを理由に飛ばさない
 *
 * > `serpTop10` が取得できない場合はADMINの手動入力値を使う。
 * > **取得できないことを理由に停止条件をスキップしてはならない**
 * > （CONTENT_PLANNING 2.1）
 *
 * だから検索結果が空なら**判定せずに落とす**。空を「該当なし」として通すと、
 * 大手が占めるジャンルが検索APIの不調のたびに通ってしまう。
 */

import { invalidStep1InputError } from './errors';

/** 検索上位の枠数（SPEC 9.2.2「上位10件」） */
export const SERP_SAMPLE_SIZE = 10;

/** 公式・大手比較がこの数以上なら停止 */
export const SERP_MAJOR_BLOCK_THRESHOLD = 8;

/** 個人ブログがこの数以下なら警告 */
export const SERP_PERSONAL_WARN_MAX = 2;

/** 差し戻しの上限。これを超えたら続行の選択肢を出す（SPEC 9.2.2） */
export const MAX_REJECTIONS = 2;

export type SerpDomainType =
  'official' | 'major_comparison' | 'personal' | 'other';

export type YmylRisk = 'HIGH' | 'MEDIUM' | 'LOW';

/** 判定の結果。`OVERRIDDEN` は利用者が承知で進めた場合（別関数が付ける） */
export type Step1Decision = 'PASSED' | 'WARNED' | 'BLOCKED';

/** 停止の理由（SPEC 9.2.2） */
export const STEP1_BLOCK_REASONS = {
  /** YMYL該当（医療・健康効果・投資・融資・保険・法律・就労） */
  ymylHigh: 'ymyl_high',
  /** 該当ASPに案件が0件 */
  noOffers: 'no_offers',
  /** 検索上位を公式・大手比較が占めている */
  serpDominatedByMajor: 'serp_dominated_by_major',
} as const;

/** 警告の理由（SPEC 9.2.2） */
export const STEP1_WARN_REASONS = {
  /** 上位に個人ブログが少ない */
  fewPersonalBlogs: 'few_personal_blogs',
  /** 利用経験なし */
  noExperience: 'no_experience',
  /** 案件が1件のみ */
  singleOffer: 'single_offer',
} as const;

export type Step1BlockReason =
  (typeof STEP1_BLOCK_REASONS)[keyof typeof STEP1_BLOCK_REASONS];

export type Step1WarnReason =
  (typeof STEP1_WARN_REASONS)[keyof typeof STEP1_WARN_REASONS];

export interface SerpEntry {
  domainType: SerpDomainType;
}

export interface Step1Input {
  genreName: string;
  /** `genres` マスタの値。利用者の申告ではない */
  ymylRisk: YmylRisk;
  /** 該当ASPの案件数 */
  offerCount: number;
  /** 検索上位。取得できなければ ADMIN の手動入力（SPEC 9.2.2 フォールバック） */
  serpTop10: readonly SerpEntry[];
  userHasExperience: boolean;
}

export interface Step1Judgement {
  decision: Step1Decision;
  /** 停止の理由。空なら停止しない */
  blockedBy: Step1BlockReason[];
  /** 警告の理由 */
  warnings: Step1WarnReason[];
  /** 停止と警告を並べたもの。`planning_runs.step1_reasons` に入れる */
  reasons: string[];
  /** 判定に使った検索結果の内訳。後から理由を辿るために残す */
  serpBreakdown: Readonly<Record<SerpDomainType, number>>;
}

function assertInput(input: Step1Input): void {
  if (!Number.isInteger(input.offerCount) || input.offerCount < 0) {
    throw invalidStep1InputError('案件数は0以上の整数で指定してください');
  }

  // **空を「該当なし」として通さない。** 検索APIの不調のたびに、
  // 大手が占めるジャンルが通ってしまう
  if (input.serpTop10.length === 0) {
    throw invalidStep1InputError(
      '検索上位の内訳がありません。取得できない場合は ADMIN が手動で入力してください',
    );
  }

  if (input.serpTop10.length > SERP_SAMPLE_SIZE) {
    throw invalidStep1InputError(
      `検索上位は${SERP_SAMPLE_SIZE}件までで指定してください`,
    );
  }
}

function countByDomainType(
  entries: readonly SerpEntry[],
): Record<SerpDomainType, number> {
  const counts: Record<SerpDomainType, number> = {
    official: 0,
    major_comparison: 0,
    personal: 0,
    other: 0,
  };

  for (const entry of entries) {
    counts[entry.domainType] += 1;
  }

  return counts;
}

/**
 * ジャンルを審査する。
 *
 * **停止が1つでもあれば `BLOCKED`。** 警告と併せて出るが、決定は停止が勝つ。
 *
 * 件数の条件は**絶対数で判定する**（SPEC 9.2.2 のとおり）。検索上位が
 * 10件に満たないときは、8件以上という停止条件が成立しにくくなるだけで、
 * 判定の意味は変わらない。
 */
export function judgeGenre(input: Step1Input): Step1Judgement {
  assertInput(input);

  const serpBreakdown = countByDomainType(input.serpTop10);
  const blockedBy: Step1BlockReason[] = [];
  const warnings: Step1WarnReason[] = [];

  if (input.ymylRisk === 'HIGH') {
    blockedBy.push(STEP1_BLOCK_REASONS.ymylHigh);
  }

  if (input.offerCount === 0) {
    blockedBy.push(STEP1_BLOCK_REASONS.noOffers);
  }

  if (
    serpBreakdown.official + serpBreakdown.major_comparison >=
    SERP_MAJOR_BLOCK_THRESHOLD
  ) {
    blockedBy.push(STEP1_BLOCK_REASONS.serpDominatedByMajor);
  }

  if (serpBreakdown.personal <= SERP_PERSONAL_WARN_MAX) {
    warnings.push(STEP1_WARN_REASONS.fewPersonalBlogs);
  }

  if (!input.userHasExperience) {
    warnings.push(STEP1_WARN_REASONS.noExperience);
  }

  if (input.offerCount === 1) {
    warnings.push(STEP1_WARN_REASONS.singleOffer);
  }

  const decision: Step1Decision =
    blockedBy.length > 0
      ? 'BLOCKED'
      : warnings.length > 0
        ? 'WARNED'
        : 'PASSED';

  return {
    decision,
    blockedBy,
    warnings,
    reasons: [...blockedBy, ...warnings],
    serpBreakdown,
  };
}

/**
 * 続行の選択肢を出すか（SPEC 9.2.2「差し戻しは2回まで。3回目は
 * 『リスクを理解して進める』を選択可能とする」）。
 *
 * **`BLOCKED` のときだけ意味を持つ。** 通っているものに「承知で進める」は要らない。
 *
 * 数え方は「これまでに差し戻された回数」。2回差し戻された次（3回目の審査）で
 * 選択肢が出る。
 */
export function offersOverride(params: {
  decision: Step1Decision;
  rejectionCount: number;
}): boolean {
  return (
    params.decision === 'BLOCKED' && params.rejectionCount >= MAX_REJECTIONS
  );
}

/** 別ジャンルの候補（AIが出し、ここで絞る） */
export interface GenreCandidate {
  name: string;
  reason: string;
  expectedYmylRisk: YmylRisk;
}

/**
 * 候補を絞る（CONTENT_PLANNING 2.3）。
 *
 * **`HIGH` と、既に停止したジャンルを外す。** プロンプトに「除いてください」と
 * 書いて信じない — 除外は判定であり、判定はコードの仕事（CONTENT_PLANNING 1.1）。
 *
 * 名前の比較は前後の空白と大小文字を無視する。**表記の揺れで同じジャンルを
 * 勧め直さない**ため。
 */
export function filterAlternatives(
  candidates: readonly GenreCandidate[],
  blockedGenreNames: readonly string[],
): GenreCandidate[] {
  const blocked = new Set(
    blockedGenreNames.map((name) => name.trim().toLowerCase()),
  );
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (candidate.expectedYmylRisk === 'HIGH') {
      return false;
    }

    const key = candidate.name.trim().toLowerCase();

    if (blocked.has(key) || seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}
