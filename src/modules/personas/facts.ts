/**
 * 本人の事実（`persona_facts`）の規則（TASKS D-6、SPEC 5.7・9.6）。
 *
 * ## 完了条件そのものが1つの規則
 *
 * > `AI_INFERENCE` かつ `UNVERIFIED` の情報は、一人称体験として記事へ
 * > 使用しない（SPEC 5.7）
 *
 * これは DATA_MODEL 4章の「アプリ層で検証する制約」8番でもある。
 *
 * **なぜ重いか。** AIが推測しただけの体験を「私は使いました」と書くと、
 * それは**架空の口コミ**になる（SPEC 9.6 の禁止事項）。読者を欺くうえに、
 * 景品表示法にも触れうる。**書き込みのたびに機械的に落とす**のが唯一の
 * 確実な方法で、画面や呼び出し側の善意に任せない。
 *
 * DBを触らない純粋な処理。保存は `repository.ts` の担当。
 */

import { invalidPersonaError } from './errors';
import {
  FACT_SOURCES,
  FACT_TYPES,
  FACT_VERIFICATIONS,
  type CreatePersonaFactInput,
  type FactSource,
  type FactType,
  type FactVerification,
  type UpdatePersonaFactInput,
} from './types';

export const FACT_CONTENT_MAX_LENGTH = 2000;

export function isFactType(value: unknown): value is FactType {
  return (
    typeof value === 'string' &&
    (FACT_TYPES as readonly string[]).includes(value)
  );
}

export function isFactSource(value: unknown): value is FactSource {
  return (
    typeof value === 'string' &&
    (FACT_SOURCES as readonly string[]).includes(value)
  );
}

export function isFactVerification(value: unknown): value is FactVerification {
  return (
    typeof value === 'string' &&
    (FACT_VERIFICATIONS as readonly string[]).includes(value)
  );
}

/**
 * 一人称体験として使ってよいか（SPEC 5.7・DATA_MODEL 4章 制約8）。
 *
 * **`AI_INFERENCE` かつ `UNVERIFIED` は必ず `false`。** 要望が `true` でも
 * 落とす。
 *
 * **`REJECTED` も `false`。** 裏取りで否定された事実を一人称で書くのは、
 * 未確認より悪い。SPEC 5.7 は明記していないが、`REJECTED` を許す読み方は
 * 成り立たない。
 */
export function canUseFirstPerson(params: {
  source: FactSource;
  verification: FactVerification;
  requested: boolean;
}): boolean {
  if (!params.requested) {
    return false;
  }

  if (params.verification === 'REJECTED') {
    return false;
  }

  if (
    params.source === 'AI_INFERENCE' &&
    params.verification === 'UNVERIFIED'
  ) {
    return false;
  }

  return true;
}

/**
 * 一人称利用が禁じられる組み合わせか。
 *
 * 画面へ「なぜ使えないか」を出すために公開する。判定そのものは
 * `canUseFirstPerson` が持つ。
 */
export function isFirstPersonBlocked(params: {
  source: FactSource;
  verification: FactVerification;
}): boolean {
  return !canUseFirstPerson({ ...params, requested: true });
}

function assertContent(value: string): string {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidPersonaError('事実の内容が空です');
  }

  if (trimmed.length > FACT_CONTENT_MAX_LENGTH) {
    throw invalidPersonaError(
      `事実の内容は${FACT_CONTENT_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  return trimmed;
}

export interface NormalizedPersonaFact {
  factType: FactType;
  content: string;
  source: FactSource;
  verification: FactVerification;
  usableFirstPerson: boolean;
}

/** @throws {AppError} 入力の不備 */
export function normalizeCreatePersonaFact(
  input: CreatePersonaFactInput,
): NormalizedPersonaFact {
  if (!isFactType(input.factType)) {
    throw invalidPersonaError('事実の種類が不正です');
  }

  if (!isFactSource(input.source)) {
    throw invalidPersonaError('事実の出どころが不正です');
  }

  const verification = input.verification ?? 'UNVERIFIED';
  if (!isFactVerification(verification)) {
    throw invalidPersonaError('裏取りの状態が不正です');
  }

  return {
    factType: input.factType,
    content: assertContent(input.content),
    source: input.source,
    verification,
    // **ここで落とす。** 呼び出し側の指定をそのまま保存しない
    usableFirstPerson: canUseFirstPerson({
      source: input.source,
      verification,
      requested: input.usableFirstPerson ?? false,
    }),
  };
}

/**
 * 編集入力を整える。
 *
 * **`source` と `verification` は現在の値と重ねてから判定する。**
 * 片方だけ更新したときに、禁じられる組み合わせを見落とさないため。
 * 例：`VERIFIED` の事実を `UNVERIFIED` へ戻すと、`AI_INFERENCE` なら
 * 一人称利用は落ちる。
 */
export function normalizeUpdatePersonaFact(
  input: UpdatePersonaFactInput,
  current: {
    source: FactSource;
    verification: FactVerification;
    usableFirstPerson: boolean;
  },
): Partial<NormalizedPersonaFact> {
  const data: Partial<NormalizedPersonaFact> = {};

  if (input.factType !== undefined) {
    if (!isFactType(input.factType)) {
      throw invalidPersonaError('事実の種類が不正です');
    }
    data.factType = input.factType;
  }

  if (input.content !== undefined) {
    data.content = assertContent(input.content);
  }

  if (input.source !== undefined) {
    if (!isFactSource(input.source)) {
      throw invalidPersonaError('事実の出どころが不正です');
    }
    data.source = input.source;
  }

  if (input.verification !== undefined) {
    if (!isFactVerification(input.verification)) {
      throw invalidPersonaError('裏取りの状態が不正です');
    }
    data.verification = input.verification;
  }

  const source = data.source ?? current.source;
  const verification = data.verification ?? current.verification;
  const requested = input.usableFirstPerson ?? current.usableFirstPerson;

  const usableFirstPerson = canUseFirstPerson({
    source,
    verification,
    requested,
  });

  // **組み合わせが変わって落ちる場合も書き戻す。**
  // 指定が無くても、現在値のままにしてはいけない
  if (usableFirstPerson !== current.usableFirstPerson) {
    data.usableFirstPerson = usableFirstPerson;
  } else if (input.usableFirstPerson !== undefined) {
    data.usableFirstPerson = usableFirstPerson;
  }

  return data;
}
