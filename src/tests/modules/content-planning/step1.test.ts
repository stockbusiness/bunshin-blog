import { describe, expect, it } from 'vitest';
import {
  MAX_REJECTIONS,
  PLANNING_ERROR_CODES,
  STEP1_BLOCK_REASONS,
  STEP1_WARN_REASONS,
  filterAlternatives,
  judgeGenre,
  offersOverride,
  type SerpDomainType,
  type SerpEntry,
  type Step1Input,
} from '@/modules/content-planning';

/**
 * STEP 1 の判定（TASKS E-4、SPEC 9.2.2）。
 *
 * 完了条件の前半「**停止条件を満たすジャンルが通過しない**」。
 *
 * DBもAIも触らない純粋な処理。**AIの出力を受け取る引数が無い**ことが
 * この関数の要点で（CONTENT_PLANNING 1.1）、受け取れる形にすると
 * いつか渡される。
 */

function serp(counts: Partial<Record<SerpDomainType, number>>): SerpEntry[] {
  const entries: SerpEntry[] = [];

  for (const [domainType, count] of Object.entries(counts)) {
    for (let index = 0; index < (count ?? 0); index += 1) {
      entries.push({ domainType: domainType as SerpDomainType });
    }
  }

  return entries;
}

/** 何も引っかからない入力 */
function input(overrides: Partial<Step1Input> = {}): Step1Input {
  return {
    genreName: '一人暮らしの節約',
    ymylRisk: 'LOW',
    offerCount: 5,
    serpTop10: serp({ personal: 6, other: 4 }),
    userHasExperience: true,
    ...overrides,
  };
}

describe('停止条件', () => {
  it('何も無ければ通る', () => {
    const result = judgeGenre(input());

    expect(result.decision).toBe('PASSED');
    expect(result.reasons).toEqual([]);
  });

  /** SPEC 9.2.2「YMYL該当（医療・健康効果・投資・融資・保険・法律・就労）」 */
  it('YMYLは通さない', () => {
    const result = judgeGenre(input({ ymylRisk: 'HIGH' }));

    expect(result.decision).toBe('BLOCKED');
    expect(result.blockedBy).toContain(STEP1_BLOCK_REASONS.ymylHigh);
  });

  it('MEDIUM と LOW は停止しない', () => {
    expect(judgeGenre(input({ ymylRisk: 'MEDIUM' })).decision).toBe('PASSED');
    expect(judgeGenre(input({ ymylRisk: 'LOW' })).decision).toBe('PASSED');
  });

  it('案件が0件なら通さない', () => {
    const result = judgeGenre(input({ offerCount: 0 }));

    expect(result.decision).toBe('BLOCKED');
    expect(result.blockedBy).toContain(STEP1_BLOCK_REASONS.noOffers);
  });

  /** 公式・大手比較が8件以上（両者の合計で数える） */
  it.each([
    [8, 0, true],
    [0, 8, true],
    [4, 4, true],
    [4, 3, false],
  ])('公式%s件・大手比較%s件 → 停止=%s', (official, major, blocked) => {
    const result = judgeGenre(
      input({
        serpTop10: serp({
          official,
          major_comparison: major,
          personal: 10 - official - major,
        }),
      }),
    );

    expect(
      result.blockedBy.includes(STEP1_BLOCK_REASONS.serpDominatedByMajor),
    ).toBe(blocked);
  });

  /** 停止と警告が同時に出ても、決定は停止が勝つ */
  it('停止があれば警告と同時でも BLOCKED', () => {
    const result = judgeGenre(
      input({ ymylRisk: 'HIGH', userHasExperience: false }),
    );

    expect(result.decision).toBe('BLOCKED');
    expect(result.warnings).toContain(STEP1_WARN_REASONS.noExperience);
  });

  it('停止の理由は重ねて出る', () => {
    const result = judgeGenre(
      input({
        ymylRisk: 'HIGH',
        offerCount: 0,
        serpTop10: serp({ official: 9, personal: 1 }),
      }),
    );

    expect(result.blockedBy).toHaveLength(3);
  });
});

describe('警告条件', () => {
  it('個人ブログが2件以下なら警告', () => {
    const result = judgeGenre(
      input({ serpTop10: serp({ personal: 2, other: 8 }) }),
    );

    expect(result.decision).toBe('WARNED');
    expect(result.warnings).toContain(STEP1_WARN_REASONS.fewPersonalBlogs);
  });

  it('個人ブログが3件なら警告しない', () => {
    const result = judgeGenre(
      input({ serpTop10: serp({ personal: 3, other: 7 }) }),
    );

    expect(result.decision).toBe('PASSED');
  });

  it('利用経験が無ければ警告', () => {
    const result = judgeGenre(input({ userHasExperience: false }));

    expect(result.warnings).toContain(STEP1_WARN_REASONS.noExperience);
  });

  it('案件が1件だけなら警告', () => {
    const result = judgeGenre(input({ offerCount: 1 }));

    expect(result.decision).toBe('WARNED');
    expect(result.warnings).toContain(STEP1_WARN_REASONS.singleOffer);
  });
});

describe('入力の検証', () => {
  /**
   * **取得できないことを理由に停止条件をスキップしない**
   * （CONTENT_PLANNING 2.1）。空を「該当なし」として通すと、
   * 大手が占めるジャンルが検索APIの不調のたびに通る。
   */
  it('検索上位が空なら判定せずに落とす', () => {
    expect(() => judgeGenre(input({ serpTop10: [] }))).toThrowError(
      expect.objectContaining({
        code: PLANNING_ERROR_CODES.invalidStep1Input,
        status: 422,
      }),
    );
  });

  it('検索上位が10件を超えたら落とす', () => {
    expect(() =>
      judgeGenre(input({ serpTop10: serp({ personal: 11 }) })),
    ).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep1Input }),
    );
  });

  it.each([[-1], [1.5], [Number.NaN]])('案件数 %s は受け付けない', (count) => {
    expect(() => judgeGenre(input({ offerCount: count }))).toThrowError(
      expect.objectContaining({ code: PLANNING_ERROR_CODES.invalidStep1Input }),
    );
  });

  /** 10件に満たなくても絶対数で判定する（SPEC 9.2.2 のとおり） */
  it('10件に満たなくても判定する', () => {
    const result = judgeGenre(
      input({ serpTop10: serp({ official: 8, personal: 1 }) }),
    );

    expect(result.blockedBy).toContain(
      STEP1_BLOCK_REASONS.serpDominatedByMajor,
    );
    expect(result.serpBreakdown.official).toBe(8);
  });
});

describe('続行の選択肢', () => {
  /** 完了条件の後半「**差し戻し2回で選択肢が出る**」 */
  it.each([
    [0, false],
    [1, false],
    [2, true],
    [3, true],
  ])('差し戻し%s回 → 選択肢=%s', (rejectionCount, expected) => {
    expect(offersOverride({ decision: 'BLOCKED', rejectionCount })).toBe(
      expected,
    );
  });

  it('通っているときは選択肢を出さない', () => {
    expect(
      offersOverride({ decision: 'PASSED', rejectionCount: MAX_REJECTIONS }),
    ).toBe(false);
    expect(
      offersOverride({ decision: 'WARNED', rejectionCount: MAX_REJECTIONS }),
    ).toBe(false);
  });
});

describe('候補の絞り込み', () => {
  const candidate = (name: string, risk: 'HIGH' | 'MEDIUM' | 'LOW') => ({
    name,
    reason: '理由',
    expectedYmylRisk: risk,
  });

  /**
   * **除外はコードで行う**（CONTENT_PLANNING 2.3）。
   * プロンプトに「除いてください」と書いて信じない。
   */
  it('HIGH の候補を外す', () => {
    const result = filterAlternatives(
      [candidate('投資入門', 'HIGH'), candidate('家計簿', 'LOW')],
      [],
    );

    expect(result.map((entry) => entry.name)).toEqual(['家計簿']);
  });

  it('既に停止したジャンルを外す', () => {
    const result = filterAlternatives(
      [candidate('医療脱毛', 'LOW'), candidate('家計簿', 'LOW')],
      ['医療脱毛'],
    );

    expect(result.map((entry) => entry.name)).toEqual(['家計簿']);
  });

  /** 表記の揺れで同じジャンルを勧め直さない */
  it('前後の空白と大小文字を無視して比べる', () => {
    const result = filterAlternatives(
      [candidate('  Fx  ', 'LOW'), candidate('家計簿', 'LOW')],
      ['fx'],
    );

    expect(result.map((entry) => entry.name)).toEqual(['家計簿']);
  });

  it('同じ候補が2つ来たら1つにする', () => {
    const result = filterAlternatives(
      [candidate('家計簿', 'LOW'), candidate('家計簿', 'MEDIUM')],
      [],
    );

    expect(result).toHaveLength(1);
  });
});
