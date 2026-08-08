/**
 * バナーの入力検証（TASKS D-3、SPEC 5.9）。
 *
 * DBを触らない純粋な処理。**保存の直前に必ず通す。**
 */

import {
  invalidBannerError,
  invalidBannerPeriodError,
  invalidBannerUrlError,
} from './errors';
import {
  BANNER_SLOTS,
  BANNER_STATUSES,
  type BannerSlot,
  type BannerStatus,
  type CreateBannerInput,
  type UpdateBannerInput,
} from './types';

export const BANNER_NAME_MAX_LENGTH = 120;
export const BANNER_URL_MAX_LENGTH = 2048;
export const TARGET_CATEGORY_MAX_LENGTH = 60;
export const TARGET_CATEGORIES_MAX = 20;

function assertText(value: string, label: string, max: number): string {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidBannerError(`${label}が空です`);
  }

  if (trimmed.length > max) {
    throw invalidBannerError(`${label}は${max}文字以内で入力してください`);
  }

  return trimmed;
}

function parseUrl(value: string, label: string): URL {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidBannerUrlError(label, '入力してください');
  }

  if (trimmed.length > BANNER_URL_MAX_LENGTH) {
    throw invalidBannerUrlError(
      label,
      `${BANNER_URL_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidBannerUrlError(label, 'URLの形式が正しくありません');
  }

  if (url.username !== '' || url.password !== '') {
    throw invalidBannerUrlError(
      label,
      'ユーザー名やパスワードを含められません',
    );
  }

  return url;
}

/**
 * 画像のURLを検証する。
 *
 * **`https` だけを許す。** バナーはモニターのブログ（https）の記事に
 * `<img>` として埋まる。`http` の画像を混ぜると混在コンテンツとして
 * ブラウザに遮断され、**バナーが表示されないまま気づかれない**。
 */
export function normalizeImageUrl(value: string): string {
  const url = parseUrl(value, '画像のURL');

  if (url.protocol !== 'https:') {
    throw invalidBannerUrlError(
      '画像のURL',
      'httpsで指定してください（httpだとブラウザに遮断されます）',
    );
  }

  return url.toString();
}

/**
 * 遷移先のURLを検証する。
 *
 * **`http` も許す。** 遷移先はASPや広告主のURLで、こちらでは選べない。
 * 画像と違い、混在コンテンツにはならない（リンク先の読み込みは
 * 記事の表示と別）。
 *
 * `javascript:` や `data:` は拒否する。記事本文へ埋めると読者の
 * ブラウザで任意のスクリプトが動く（D-1 と同じ方針）。
 */
export function normalizeDestinationUrl(value: string): string {
  const url = parseUrl(value, '遷移先のURL');

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidBannerUrlError(
      '遷移先のURL',
      'httpまたはhttpsで指定してください',
    );
  }

  return url.toString();
}

export function isBannerSlot(value: string): value is BannerSlot {
  return (BANNER_SLOTS as readonly string[]).includes(value);
}

export function isBannerStatus(value: string): value is BannerStatus {
  return (BANNER_STATUSES as readonly string[]).includes(value);
}

/**
 * 対象カテゴリを整える。
 *
 * **空の配列は「全ての記事が対象」を表す。** 未指定と区別しない
 * （SPEC 5.9 は既定を定めていない。絞り込みを指定しなければ全件、が
 * 素直な読み方）。
 *
 * **重複を落とす。** 同じカテゴリが2つ入っていても意味が無く、
 * 一覧の表示だけが崩れる。
 */
export function normalizeTargetCategories(
  values: string[] | undefined,
): string[] {
  if (values === undefined) {
    return [];
  }

  if (values.length > TARGET_CATEGORIES_MAX) {
    throw invalidBannerError(
      `対象カテゴリは${TARGET_CATEGORIES_MAX}件までです`,
    );
  }

  const normalized = values.map((value, index) =>
    assertText(value, `対象カテゴリ${index + 1}`, TARGET_CATEGORY_MAX_LENGTH),
  );

  return [...new Set(normalized)];
}

/**
 * 掲載期間を確かめる。
 *
 * **終了が開始より前なら拒否する。** 逆になっているバナーは一度も
 * 表示されず、原因が「表示ロジックの不具合」に見える（D-1 と同じ理由）。
 */
export function assertBannerPeriod(
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
): void {
  if (
    startsAt === undefined ||
    startsAt === null ||
    endsAt === undefined ||
    endsAt === null
  ) {
    return;
  }

  if (endsAt.getTime() <= startsAt.getTime()) {
    throw invalidBannerPeriodError();
  }
}

export interface NormalizedCreateBanner {
  name: string;
  imageUrl: string;
  destinationUrl: string;
  slot: BannerSlot;
  targetCategories: string[];
  status: BannerStatus;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** @throws {AppError} 入力の不備 */
export function normalizeCreateBanner(
  input: CreateBannerInput,
): NormalizedCreateBanner {
  if (!isBannerSlot(input.slot)) {
    throw invalidBannerError('表示位置の値が不正です');
  }

  const status = input.status ?? 'ACTIVE';
  if (!isBannerStatus(status)) {
    throw invalidBannerError('状態の値が不正です');
  }

  assertBannerPeriod(input.startsAt, input.endsAt);

  return {
    name: assertText(input.name, 'バナー名', BANNER_NAME_MAX_LENGTH),
    imageUrl: normalizeImageUrl(input.imageUrl),
    destinationUrl: normalizeDestinationUrl(input.destinationUrl),
    slot: input.slot,
    targetCategories: normalizeTargetCategories(input.targetCategories),
    status,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  };
}

/**
 * 更新入力を整える。
 *
 * **渡された項目だけを返す。** `undefined` は「変えない」を意味する。
 * `affiliateOfferId` は所有権の確認が要るため、ここでは扱わない
 * （`repository.ts` の担当）。
 */
export function normalizeUpdateBanner(
  input: UpdateBannerInput,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    data['name'] = assertText(input.name, 'バナー名', BANNER_NAME_MAX_LENGTH);
  }

  if (input.imageUrl !== undefined) {
    data['imageUrl'] = normalizeImageUrl(input.imageUrl);
  }

  if (input.destinationUrl !== undefined) {
    data['destinationUrl'] = normalizeDestinationUrl(input.destinationUrl);
  }

  if (input.slot !== undefined) {
    if (!isBannerSlot(input.slot)) {
      throw invalidBannerError('表示位置の値が不正です');
    }
    data['slot'] = input.slot;
  }

  if (input.targetCategories !== undefined) {
    data['targetCategories'] = normalizeTargetCategories(
      input.targetCategories,
    );
  }

  if (input.status !== undefined) {
    if (!isBannerStatus(input.status)) {
      throw invalidBannerError('状態の値が不正です');
    }
    data['status'] = input.status;
  }

  if (input.startsAt !== undefined) {
    data['startsAt'] = input.startsAt;
  }

  if (input.endsAt !== undefined) {
    data['endsAt'] = input.endsAt;
  }

  return data;
}
