/**
 * 事実チェックの判定（TASKS E-12、CONTENT_PLANNING 8.2、SPEC 9.7）。
 *
 * ## 照合はコードで行う
 *
 * > 本文から事実主張を抽出させる**だけ**。**照合はコードで行う。**
 * > （CONTENT_PLANNING 8.1）
 *
 * AIには「この記事は何を主張しているか」だけを答えさせ、
 * 「その主張が正しいか」は**一切訊かない**。訊けば「正しいです」と
 * 返ってくるだけで、確かめたことにならない。
 *
 * ## 照合できないものは未確認として扱う
 *
 * 文字列一致で日本語の言い換えは追えない。**追えなかったものを
 * 「確認済み」に倒さない** — 未確認として承認者に見せる側へ倒す。
 * 誤って未確認にした場合の損失は「人が1つ確かめる」で、
 * 誤って確認済みにした場合の損失は「嘘が公開される」。
 *
 * DBも外部も触らない純粋な処理。
 */

/** 主張の種別（CONTENT_PLANNING 8.1） */
export const CLAIM_TYPES = [
  'PRICE',
  'CONDITION',
  'FEATURE',
  'EXPERIENCE',
  'GENERAL',
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * `interface` ではなく `type` で書く。
 *
 * **そのまま `jsonb` に入る。** `interface` は暗黙のインデックス署名を
 * 持たないため Prisma の `InputJsonValue` に渡せず、保存の直前で
 * 型を潰すことになる。
 */
export type ExtractedClaim = {
  text: string;
  type: ClaimType;
  excerpt: string;
};

/** 事実チェックの結果（SPEC 9.7、`article_versions.fact_check_status`） */
export type FactCheckStatus = 'PASSED' | 'WARNING' | 'FAILED';

/**
 * 未確認と判定した主張。`article_versions.unverified_claims` に入る。
 *
 * **なぜ未確認なのかを残す。** 承認画面（F-5）で人が確かめるとき、
 * 「照合先が空だった」と「数値が facts に無い」では見るところが違う。
 */
export type UnverifiedClaim = ExtractedClaim & {
  reason: UnverifiedReason;
};

export type UnverifiedReason =
  /** 照合先そのものが無い（`GENERAL`、または facts が空） */
  | 'NO_SOURCE'
  /** facts のどの記述にも触れていない */
  | 'NOT_IN_FACTS'
  /** facts に無い数値が含まれている */
  | 'NUMBER_NOT_IN_FACTS';

/** `facts` が古いと見なす日数（CONTENT_PLANNING 8.2） */
export const FACTS_STALE_DAYS = 90;

/**
 * 照合のための正規化。
 *
 * **全角・半角と空白の揺れを吸収する。** 「月額 500円」と「月額５００円」を
 * 別物と判定すると、facts に書いてあるのに未確認になる。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * 文字列から数値を抜き出す。
 *
 * **桁区切りを外す。** 「1,980円」と「1980円」は同じ数値。
 */
export function extractNumbers(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/,/g, '');

  return [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

/**
 * `facts`（jsonb）を照合に使う文字列の集まりへ均す。
 *
 * **葉の値だけを取り、キー名は取らない。** キーは英語（`price` など）で、
 * 日本語の本文と当たらないうえ、短い語が偶然一致して**未確認を見逃す**。
 *
 * **`updatedAt` は外す。** 日付の数字が「facts にある数値」として数えられ、
 * 本文の「2026年」のような無関係な数値を通してしまう。
 */
export function flattenFactStrings(facts: unknown): string[] {
  const collected: string[] = [];

  const walk = (value: unknown, key: string | null): void => {
    if (key === 'updatedAt') {
      return;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      collected.push(String(value));

      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, null);
      }

      return;
    }

    if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, childKey);
      }
    }
  };

  walk(facts, null);

  return collected;
}

/**
 * 主張が facts に裏付けられているかを判定する。
 *
 * 2つとも満たしたときだけ「確認済み」とする。
 *
 * 1. facts のどれかの記述が、主張の文にそのまま現れる
 * 2. 主張に含まれる数値が、すべて facts の数値にある
 *
 * 2 が完了条件の「**facts外の数値を検出**」。1 だけだと、
 * 「月額500円」が facts にあることを根拠に「初期費用3,000円」まで
 * 通ってしまう。
 */
export function checkAgainstFacts(params: {
  claimText: string;
  factStrings: readonly string[];
}): UnverifiedReason | null {
  if (params.factStrings.length === 0) {
    return 'NO_SOURCE';
  }

  const text = normalizeForMatch(params.claimText);

  // 1文字の値は偶然当たる。2文字以上を照合の手がかりにする
  const mentions = params.factStrings
    .map(normalizeForMatch)
    .filter((fact) => fact.length >= 2);

  if (!mentions.some((fact) => text.includes(fact))) {
    return 'NOT_IN_FACTS';
  }

  const factNumbers = new Set(
    params.factStrings.flatMap((fact) => extractNumbers(fact)),
  );

  if (
    extractNumbers(params.claimText).some((number) => !factNumbers.has(number))
  ) {
    return 'NUMBER_NOT_IN_FACTS';
  }

  return null;
}

export interface VerifyClaimsInput {
  claims: readonly ExtractedClaim[];
  /** 案件の `facts`（`PRICE` / `CONDITION` / `FEATURE` の照合先） */
  offerFacts: unknown;
  /**
   * 一人称で使ってよい本人の事実（`EXPERIENCE` の照合先）。
   *
   * **`usableFirstPerson = true` のものだけを渡す**（CONTENT_PLANNING 8.2）。
   * 呼び出し側で絞る。
   */
  usablePersonaFacts: readonly string[];
}

/**
 * 主張を照合し、未確認のものを返す（CONTENT_PLANNING 8.2）。
 *
 * ```ts
 * // PRICE / CONDITION / FEATURE → offer.facts に対応があるか
 * // EXPERIENCE → usableFirstPerson = true の persona_facts に対応があるか
 * ```
 *
 * **`GENERAL` に照合先は無い。** 一般論は保存された事実に紐づかないので、
 * 常に未確認になる。これは判定漏れではなく、SPEC 9.7 の `WARNING`
 * （「`GENERAL` のみ未確認」）が想定している状態そのもの。
 */
export function verifyClaims(input: VerifyClaimsInput): UnverifiedClaim[] {
  const offerFactStrings = flattenFactStrings(input.offerFacts);
  const unverified: UnverifiedClaim[] = [];

  for (const claim of input.claims) {
    if (claim.type === 'GENERAL') {
      unverified.push({ ...claim, reason: 'NO_SOURCE' });

      continue;
    }

    const factStrings =
      claim.type === 'EXPERIENCE' ? input.usablePersonaFacts : offerFactStrings;

    const reason = checkAgainstFacts({
      claimText: claim.text,
      factStrings,
    });

    if (reason !== null) {
      unverified.push({ ...claim, reason });
    }
  }

  return unverified;
}

/**
 * `facts` が古いかを判定する（CONTENT_PLANNING 8.2）。
 *
 * > `offer.facts.updatedAt` が90日より古い場合は、照合が一致しても
 * > `WARNING` とする
 *
 * **`updatedAt` が無ければ古い扱いにする。** 「いつ確かめたか分からない」を
 * 「新しい」に倒すと、**測っていないことが「問題なし」に化ける**。
 * 現状これを書き込む経路が無いため、実質すべての案件が該当する（Q-022）。
 */
export function areFactsStale(params: { facts: unknown; now: Date }): boolean {
  const updatedAt =
    typeof params.facts === 'object' &&
    params.facts !== null &&
    !Array.isArray(params.facts)
      ? (params.facts as Record<string, unknown>)['updatedAt']
      : undefined;

  if (typeof updatedAt !== 'string') {
    return true;
  }

  const parsed = new Date(updatedAt);

  if (Number.isNaN(parsed.getTime())) {
    return true;
  }

  const ageDays =
    (params.now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1_000);

  return ageDays > FACTS_STALE_DAYS;
}

/**
 * 事実チェックの結果を決める（SPEC 9.7、CONTENT_PLANNING 8.2）。
 *
 * | 結果 | 条件 |
 * |---|---|
 * | `PASSED` | 未確認主張が0件 |
 * | `WARNING` | `GENERAL` のみ未確認 |
 * | `FAILED` | `PRICE` / `CONDITION` / `FEATURE` / `EXPERIENCE` に未確認あり |
 *
 * **古い `facts` は `FAILED` を `WARNING` へ緩めない。** 引き上げるだけ。
 */
export function judgeFactCheck(params: {
  unverified: readonly UnverifiedClaim[];
  factsAreStale: boolean;
}): FactCheckStatus {
  if (params.unverified.some((claim) => claim.type !== 'GENERAL')) {
    return 'FAILED';
  }

  if (params.unverified.length > 0 || params.factsAreStale) {
    return 'WARNING';
  }

  return 'PASSED';
}

/**
 * 承認依頼へ送ってよいかを判定する（SPEC 9.7）。
 *
 * > `FAILED` は承認依頼へ送らない
 *
 * **`NOT_CHECKED` も送らない。** チェックしていない記事と
 * チェックを通った記事を、承認画面で見分けられなくなる。
 */
export function isApprovable(status: FactCheckStatus | 'NOT_CHECKED'): boolean {
  return status === 'PASSED' || status === 'WARNING';
}
