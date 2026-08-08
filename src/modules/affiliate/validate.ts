/**
 * 案件の入力検証（TASKS D-1、SPEC 5.8）。
 *
 * DBを触らない純粋な処理。**保存の直前に必ず通す。**
 */

import {
  invalidOfferError,
  invalidPeriodError,
  invalidUrlError,
} from './errors';
import {
  CONVERSION_TYPES,
  OFFER_STATUSES,
  USER_EXPERIENCES,
  type ConversionType,
  type CreateOfferInput,
  type OfferStatus,
  type UpdateOfferInput,
  type UserExperience,
} from './types';

export const OFFER_NAME_MAX_LENGTH = 120;
export const ASP_NAME_MAX_LENGTH = 60;
export const ADVERTISER_NAME_MAX_LENGTH = 120;
export const OFFER_URL_MAX_LENGTH = 2048;
export const DENY_CONDITION_MAX_LENGTH = 200;
export const DENY_CONDITIONS_MAX = 20;
/** 報酬額の上限。桁の打ち間違いを弾く（100万円） */
export const REWARD_YEN_MAX = 1_000_000;
export const USER_RATING_MIN = 1;
export const USER_RATING_MAX = 5;

function assertText(value: string, label: string, max: number): string {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidOfferError(`${label}が空です`);
  }

  if (trimmed.length > max) {
    throw invalidOfferError(`${label}は${max}文字以内で入力してください`);
  }

  return trimmed;
}

/**
 * 掲載用のURLを検証する。
 *
 * **`http` と `https` だけを許す。** `javascript:` や `data:` を記事本文へ
 * 埋めると、読者のブラウザで任意のスクリプトが動く。
 *
 * **到達確認はしない。** それは D-2（LP自動評価）の担当で、`safeFetch`
 * （C-7）を通す。ここは形式だけを見る。
 */
export function normalizeOfferUrl(value: string, label: string): string {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidUrlError(label, '入力してください');
  }

  if (trimmed.length > OFFER_URL_MAX_LENGTH) {
    throw invalidUrlError(
      label,
      `${OFFER_URL_MAX_LENGTH}文字以内で入力してください`,
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidUrlError(label, 'URLの形式が正しくありません');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidUrlError(label, 'httpまたはhttpsで指定してください');
  }

  // 認証情報付きURL（`https://user:pass@host/`）。記事へ埋める値に入れない
  if (url.username !== '' || url.password !== '') {
    throw invalidUrlError(label, 'ユーザー名やパスワードを含められません');
  }

  return url.toString();
}

function assertReward(value: number | undefined | null): void {
  if (value === undefined || value === null) {
    return;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw invalidOfferError('報酬額は0以上の整数で入力してください');
  }

  if (value > REWARD_YEN_MAX) {
    throw invalidOfferError(
      `報酬額は${REWARD_YEN_MAX}円以内で入力してください`,
    );
  }
}

function assertRating(value: number | undefined | null): void {
  if (value === undefined || value === null) {
    return;
  }

  if (
    !Number.isInteger(value) ||
    value < USER_RATING_MIN ||
    value > USER_RATING_MAX
  ) {
    throw invalidOfferError(
      `評価は${USER_RATING_MIN}〜${USER_RATING_MAX}で入力してください`,
    );
  }
}

function assertDenyConditions(values: string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }

  if (values.length > DENY_CONDITIONS_MAX) {
    throw invalidOfferError(`NG条件は${DENY_CONDITIONS_MAX}件までです`);
  }

  return values.map((value, index) =>
    assertText(value, `NG条件${index + 1}`, DENY_CONDITION_MAX_LENGTH),
  );
}

/**
 * 掲載期間を確かめる。
 *
 * **終了日が開始日より前なら拒否する。** 逆になっていると案件が
 * 一度も選ばれず、原因が「選定ロジックの不具合」に見える（F-2）。
 */
export function assertPeriod(
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
    throw invalidPeriodError();
  }
}

export function isConversionType(value: string): value is ConversionType {
  return (CONVERSION_TYPES as readonly string[]).includes(value);
}

export function isUserExperience(value: string): value is UserExperience {
  return (USER_EXPERIENCES as readonly string[]).includes(value);
}

export function isOfferStatus(value: string): value is OfferStatus {
  return (OFFER_STATUSES as readonly string[]).includes(value);
}

/** 保存できる形に整えた作成入力 */
export interface NormalizedCreateOffer {
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  affiliateUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  facts: unknown;
  userExperience: UserExperience;
  userRating: number | null;
  denyConditions: string[];
  status: OfferStatus;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** @throws {AppError} 入力の不備 */
export function normalizeCreateOffer(
  input: CreateOfferInput,
): NormalizedCreateOffer {
  if (!isConversionType(input.conversionType)) {
    throw invalidOfferError('成果地点の種類が不正です');
  }

  const userExperience = input.userExperience ?? 'UNKNOWN';
  if (!isUserExperience(userExperience)) {
    throw invalidOfferError('利用経験の値が不正です');
  }

  const status = input.status ?? 'DRAFT';
  if (!isOfferStatus(status)) {
    throw invalidOfferError('状態の値が不正です');
  }

  assertReward(input.rewardYen);
  assertRating(input.userRating);
  assertPeriod(input.startsAt, input.endsAt);

  return {
    name: assertText(input.name, '案件名', OFFER_NAME_MAX_LENGTH),
    aspName: assertText(input.aspName, 'ASP名', ASP_NAME_MAX_LENGTH),
    advertiserName:
      input.advertiserName === undefined || input.advertiserName.trim() === ''
        ? null
        : assertText(
            input.advertiserName,
            '広告主名',
            ADVERTISER_NAME_MAX_LENGTH,
          ),
    landingPageUrl: normalizeOfferUrl(input.landingPageUrl, 'LPのURL'),
    affiliateUrl: normalizeOfferUrl(input.affiliateUrl, 'アフィリエイトURL'),
    rewardYen: input.rewardYen ?? null,
    conversionType: input.conversionType,
    facts: input.facts ?? {},
    userExperience,
    userRating: input.userRating ?? null,
    denyConditions: assertDenyConditions(input.denyConditions),
    status,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  };
}

/**
 * 更新入力を整える。
 *
 * **渡された項目だけを返す。** `undefined` は「変えない」を意味する
 * （B-3 の `updateBlogForUser` と同じ扱い）。
 */
export function normalizeUpdateOffer(
  input: UpdateOfferInput,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    data['name'] = assertText(input.name, '案件名', OFFER_NAME_MAX_LENGTH);
  }

  if (input.aspName !== undefined) {
    data['aspName'] = assertText(input.aspName, 'ASP名', ASP_NAME_MAX_LENGTH);
  }

  if (input.advertiserName !== undefined) {
    data['advertiserName'] =
      input.advertiserName === null || input.advertiserName.trim() === ''
        ? null
        : assertText(
            input.advertiserName,
            '広告主名',
            ADVERTISER_NAME_MAX_LENGTH,
          );
  }

  if (input.landingPageUrl !== undefined) {
    data['landingPageUrl'] = normalizeOfferUrl(input.landingPageUrl, 'LPのURL');
  }

  if (input.affiliateUrl !== undefined) {
    data['affiliateUrl'] = normalizeOfferUrl(
      input.affiliateUrl,
      'アフィリエイトURL',
    );
  }

  if (input.rewardYen !== undefined) {
    assertReward(input.rewardYen);
    data['rewardYen'] = input.rewardYen;
  }

  if (input.conversionType !== undefined) {
    if (!isConversionType(input.conversionType)) {
      throw invalidOfferError('成果地点の種類が不正です');
    }
    data['conversionType'] = input.conversionType;
  }

  if (input.facts !== undefined) {
    data['facts'] = input.facts;
  }

  if (input.userExperience !== undefined) {
    if (!isUserExperience(input.userExperience)) {
      throw invalidOfferError('利用経験の値が不正です');
    }
    data['userExperience'] = input.userExperience;
  }

  if (input.userRating !== undefined) {
    assertRating(input.userRating);
    data['userRating'] = input.userRating;
  }

  if (input.denyConditions !== undefined) {
    data['denyConditions'] = assertDenyConditions(input.denyConditions);
  }

  if (input.status !== undefined) {
    if (!isOfferStatus(input.status)) {
      throw invalidOfferError('状態の値が不正です');
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
