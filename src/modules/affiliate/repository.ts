/**
 * `affiliate_offers` テーブルへのアクセス（TASKS D-1、SPEC 5.8）。
 *
 * **このモジュールだけが `affiliate_offers` を触る**（MODULE_RULES 1）。
 * **所有権は `blogs` モジュールの公開関数で確かめる**（SPEC 14.1）。
 *
 * 完了条件は「**ブログ別に分離。他ブログの案件が見えない**」。
 * ブログをまたいだ取得・更新は 404 に揃える（C-6 で通しで確かめている）。
 */

import { prisma } from '@/lib/db';
import { notFoundError, requireBlogForUser } from '@/modules/blogs';
import type {
  AppAffiliateOffer,
  ConversionType,
  CreateOfferInput,
  LinkMode,
  OfferStatus,
  UpdateOfferInput,
  UserExperience,
} from './types';
import {
  evaluateLandingPage,
  type EvaluateLandingPageOptions,
  type LpEvaluation,
} from './lp-evaluation';
import { normalizeCreateOffer, normalizeUpdateOffer } from './validate';
import { assertPeriod } from './validate';

interface OfferRow {
  id: string;
  blogId: string;
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  affiliateUrl: string;
  rewardYen: number | null;
  conversionType: string;
  facts: unknown;
  userExperience: string;
  userRating: number | null;
  denyConditions: string[];
  status: string;
  linkMode: string;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 外向けの表現へ写す。
 *
 * **`sub_id_param` を含めない。** ADMIN が運用で入れる値で（Q-014）、
 * モニターへ返す理由が無い。リンクの組み立てにしか使わない。
 */
function toAppOffer(row: OfferRow): AppAffiliateOffer {
  return {
    id: row.id,
    blogId: row.blogId,
    name: row.name,
    aspName: row.aspName,
    advertiserName: row.advertiserName,
    landingPageUrl: row.landingPageUrl,
    affiliateUrl: row.affiliateUrl,
    rewardYen: row.rewardYen,
    conversionType: row.conversionType as ConversionType,
    facts: row.facts,
    userExperience: row.userExperience as UserExperience,
    userRating: row.userRating,
    denyConditions: row.denyConditions,
    status: row.status as OfferStatus,
    linkMode: row.linkMode as LinkMode,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SELECT = {
  id: true,
  blogId: true,
  name: true,
  aspName: true,
  advertiserName: true,
  landingPageUrl: true,
  affiliateUrl: true,
  rewardYen: true,
  conversionType: true,
  facts: true,
  userExperience: true,
  userRating: true,
  denyConditions: true,
  status: true,
  linkMode: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** リンクの組み立てに要る分だけを取る（`sub_id_param` を含む） */
const LINK_SELECT = {
  id: true,
  blogId: true,
  affiliateUrl: true,
  linkMode: true,
  subIdParam: true,
} as const;

/**
 * 所有権を確かめ、対象のブログIDを返す。
 *
 * `CLOSED` のブログには案件を足させない（C-1 の `requireOpenBlogId` と同じ）。
 */
async function requireOpenBlogId(params: {
  userId: string;
  blogId: string;
}): Promise<string> {
  const blog = await requireBlogForUser(params);

  if (blog.status === 'CLOSED') {
    throw notFoundError();
  }

  return blog.id;
}

/** ブログの案件を一覧する。**他ブログのものは出ない** */
export async function listOffersForUser(
  params: { userId: string; blogId: string },
  options: { status?: OfferStatus | undefined } = {},
): Promise<AppAffiliateOffer[]> {
  const blogId = await requireOpenBlogId(params);

  const rows = await prisma.affiliateOffer.findMany({
    where: {
      blogId,
      ...(options.status === undefined ? {} : { status: options.status }),
    },
    orderBy: [{ createdAt: 'asc' }],
    select: SELECT,
  });

  return rows.map(toAppOffer);
}

/**
 * 案件を1件引く。無ければ `null`。
 *
 * **`blog_id` を条件に入れる。** 案件IDだけで引くと、他ブログの案件が
 * 取れてしまう（`affiliate_offers.id` は全ブログで一意）。
 */
export async function findOfferForUser(params: {
  userId: string;
  blogId: string;
  offerId: string;
}): Promise<AppAffiliateOffer | null> {
  const blogId = await requireOpenBlogId(params);

  const row = await prisma.affiliateOffer.findFirst({
    where: { id: params.offerId, blogId },
    select: SELECT,
  });

  return row === null ? null : toAppOffer(row);
}

/** 案件を1件引く。無ければ404（他ブログのものも404） */
export async function requireOfferForUser(params: {
  userId: string;
  blogId: string;
  offerId: string;
}): Promise<AppAffiliateOffer> {
  const offer = await findOfferForUser(params);

  if (offer === null) {
    throw notFoundError('案件');
  }

  return offer;
}

/**
 * 案件を登録する。
 *
 * **`link_mode` と `sub_id_param` は入力から受け取らない。** どちらも
 * ASPの規約に関わる判断で、**モニターに判断させない**（Q-001・Q-014）。
 * `link_mode` は既定の `DIRECT`（安全側）、`sub_id_param` は `NULL` で入り、
 * ADMIN が SQL で設定する（SPEC 10.3 と同じ扱い）。
 */
export async function createOfferForUser(
  params: { userId: string; blogId: string },
  input: CreateOfferInput,
): Promise<AppAffiliateOffer> {
  const blogId = await requireOpenBlogId(params);
  const data = normalizeCreateOffer(input);

  const row = await prisma.affiliateOffer.create({
    data: {
      blogId,
      name: data.name,
      aspName: data.aspName,
      advertiserName: data.advertiserName,
      landingPageUrl: data.landingPageUrl,
      affiliateUrl: data.affiliateUrl,
      rewardYen: data.rewardYen,
      conversionType: data.conversionType,
      facts: data.facts as object,
      userExperience: data.userExperience,
      userRating: data.userRating,
      denyConditions: data.denyConditions,
      status: data.status,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
    },
    select: SELECT,
  });

  return toAppOffer(row);
}

/**
 * 案件を更新する。他ブログのものは404。
 *
 * **掲載期間は保存後の値どうしで確かめる。** 片方だけを更新したときに、
 * 既存のもう片方と逆転するのを防ぐ。
 */
export async function updateOfferForUser(
  params: { userId: string; blogId: string; offerId: string },
  input: UpdateOfferInput,
): Promise<AppAffiliateOffer> {
  const current = await requireOfferForUser(params);
  const data = normalizeUpdateOffer(input);

  if (Object.keys(data).length === 0) {
    return current;
  }

  assertPeriod(
    (data['startsAt'] as Date | null | undefined) ?? current.startsAt,
    (data['endsAt'] as Date | null | undefined) ?? current.endsAt,
  );

  const result = await prisma.affiliateOffer.updateMany({
    where: { id: params.offerId, blogId: current.blogId },
    data,
  });

  // 0件なら「存在しない」か「他ブログのもの」。どちらも404に揃える
  if (result.count === 0) {
    throw notFoundError('案件');
  }

  return requireOfferForUser(params);
}

/**
 * 案件を終了する。
 *
 * **物理削除しない。** 記事に埋め込んだリンクが残っており、
 * 成果の紐付け（サブID）も過去分を参照する。`ENDED` にする。
 */
export async function endOfferForUser(params: {
  userId: string;
  blogId: string;
  offerId: string;
}): Promise<AppAffiliateOffer> {
  await requireOfferForUser(params);

  return updateOfferForUser(params, { status: 'ENDED' });
}

/**
 * リンクの組み立てに使う案件を引く（`buildAffiliateLink` の入力）。
 *
 * **`sub_id_param` を返す唯一の経路。** 外向けの `AppAffiliateOffer` には
 * 含めない。
 */
export async function readLinkableOfferForUser(params: {
  userId: string;
  blogId: string;
  offerId: string;
}): Promise<{
  id: string;
  affiliateUrl: string;
  linkMode: LinkMode;
  subIdParam: string | null;
}> {
  const blogId = await requireOpenBlogId(params);

  const row = await prisma.affiliateOffer.findFirst({
    where: { id: params.offerId, blogId },
    select: LINK_SELECT,
  });

  if (row === null) {
    throw notFoundError('案件');
  }

  return {
    id: row.id,
    affiliateUrl: row.affiliateUrl,
    linkMode: row.linkMode as LinkMode,
    subIdParam: row.subIdParam,
  };
}

/**
 * LPを評価して結果を保存する（D-2、SPEC 9.2.3）。
 *
 * **保存済みの `landing_page_url` を使う。** 呼び出し側にURLを渡させない。
 * 渡せると、案件と無関係な宛先へリクエストを出せてしまう（SSRF の入口が
 * 増える。C-3 の「リクエストに接続情報を渡させない」と同じ考え）。
 *
 * **失敗したら列を触らない。** 前回の評価結果を消して `NULL` に戻すと、
 * 一時的な障害で案件が選定から落ちる（SPEC 9.2.3 の足切り）。
 *
 * @throws {AppError} 他ブログの案件（404）・到達不可・HTMLでない
 */
export async function evaluateLandingPageForUser(
  params: { userId: string; blogId: string; offerId: string },
  options: { fetchFn?: EvaluateLandingPageOptions['fetchFn'] } = {},
): Promise<{ offer: AppAffiliateOffer; evaluation: LpEvaluation }> {
  const offer = await requireOfferForUser(params);

  const evaluation = await evaluateLandingPage({
    landingPageUrl: offer.landingPageUrl,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });

  const row = await prisma.affiliateOffer.update({
    where: { id: offer.id },
    data: {
      lpFormFields: evaluation.formFields,
      lpMobileReady: evaluation.mobileReady,
      lpContentLength: evaluation.contentLength,
      lpEvaluatedAt: new Date(),
    },
    select: SELECT,
  });

  return { offer: toAppOffer(row), evaluation };
}
