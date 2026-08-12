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
import { appendSubId, buildSubId } from './link';
import { invalidOfferError } from './errors';
import { generateRedirectCode, isRedirectCode } from './redirect-link';
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
  lpFormFields: number | null;
  lpMobileReady: boolean | null;
  lpEvaluatedAt: Date | null;
  blogPostingProhibited: boolean;
  selectionScore: number | null;
  scoreBreakdown: unknown;
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
    lpFormFields: row.lpFormFields,
    lpMobileReady: row.lpMobileReady,
    lpEvaluatedAt: row.lpEvaluatedAt,
    blogPostingProhibited: row.blogPostingProhibited,
    selectionScore: row.selectionScore,
    scoreBreakdown: row.scoreBreakdown,
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
  // LPの自動評価（D-2）の結果。**スコアリング（E-5）が読む**
  lpFormFields: true,
  lpMobileReady: true,
  lpEvaluatedAt: true,
  // ASPの規約。ADMIN が設定する（Q-019）
  blogPostingProhibited: true,
  selectionScore: true,
  scoreBreakdown: true,
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
  name: true,
  facts: true,
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
    // `created_at` はミリ秒までしか持たない。同じミリ秒に作られると
    // 前後が決まらないので、`id` を最後の決め手にして並びを固定する
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
 * リンクの組み立てと記事生成に使う案件を引く。
 *
 * `buildAffiliateLink` の入力であり、記事生成の入力
 * （CONTENT_PLANNING 7.1 の `offer`）でもある。**`name` と `facts` は
 * ここから渡す** — 記事に書いてよい事実の範囲そのもので、
 * 呼び出し側に組み立てさせない。
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
  /** 案件が属するブログ。**確認済みの値**（D-11 がリンクへ写す） */
  blogId: string;
  name: string;
  /** 記事に書いてよい価格・条件・機能（SPEC 9.6、E-12 が照合する） */
  facts: unknown;
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
    blogId,
    name: row.name,
    facts: row.facts,
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

/**
 * `affiliate_links` テーブルへのアクセス（TASKS D-8、Q-001）。
 *
 * **このモジュールだけが `affiliate_links` を触る**（MODULE_RULES 1）。
 */

const REDIRECT_LINK_SELECT = {
  id: true,
  code: true,
  affiliateOfferId: true,
  contentItemId: true,
  destinationUrl: true,
  createdAt: true,
} as const;

export interface AppAffiliateLink {
  id: string;
  code: string;
  affiliateOfferId: string;
  contentItemId: string | null;
  destinationUrl: string;
  createdAt: Date;
}

/**
 * 記事に埋めるリンクを用意する（`REDIRECT` の案件のみ）。
 *
 * **同じ案件×記事の組では作り直さない。** 記事を再生成するたびに新しい
 * コードを発行すると、**公開済み記事に埋まった古いコードが宙に浮く**
 * （消せば404、残せばクリック数が分散する）。
 *
 * **`DIRECT` の案件では発行しない。** 直リンクのまま出すので、行を作る
 * 意味が無い（Q-001）。
 *
 * **`content_item_id` が同じブログのものかは確かめていない。**
 * `content_items` は `content-planning` の所有で、そのモジュールは
 * まだ無い（MODULE_RULES 1 により直接読めない）。C-6 のときと同じ状況だが、
 * **`affiliate_links` に `blog_id` が無いため複合外部キーでも表せない**。
 * 影響は成果の紐付けが別ブログの記事IDになることまでで、他人を止めたり
 * 情報を漏らしたりはしない。**`content-planning` モジュールは E-4 で作られる**
 * ので、その時点で塞ぐ。
 *
 * @throws {AppError} 他ブログの案件（404）・`DIRECT` の案件
 */
export async function ensureRedirectLinkForUser(params: {
  userId: string;
  blogId: string;
  offerId: string;
  contentItemId: string;
  slotNumber: number;
}): Promise<AppAffiliateLink> {
  const offer = await readLinkableOfferForUser(params);

  if (offer.linkMode !== 'REDIRECT') {
    throw invalidOfferError(
      'この案件は直リンクで掲載する設定です（リダイレクタを使いません）',
    );
  }

  const existing = await prisma.affiliateLink.findFirst({
    where: {
      affiliateOfferId: offer.id,
      contentItemId: params.contentItemId,
      blogId: offer.blogId,
    },
    select: REDIRECT_LINK_SELECT,
  });

  if (existing !== null) {
    return existing;
  }

  // **飛び先だけを作る。** `buildAffiliateLink` は `href`（`/go/<code>`）も
  // 作るため `APP_BASE_URL` が要るが、保存するのは飛び先だけで、
  // `href` は記事生成が発行済みのコードから組み立てる
  const { url: destinationUrl } = appendSubId(
    offer.affiliateUrl,
    offer.subIdParam,
    buildSubId({
      slotNumber: params.slotNumber,
      contentItemId: params.contentItemId,
    }),
  );

  return prisma.affiliateLink.create({
    data: {
      code: generateRedirectCode(),
      affiliateOfferId: offer.id,
      contentItemId: params.contentItemId,
      // **案件のブログを入れる。** 記事が同じブログのものかは、この列を
      // 使った複合外部キーがDB側で確かめる（D-11・Q-020）。渡された
      // `contentItemId` が他人の記事なら、ここで外部キー違反になる
      blogId: offer.blogId,
      destinationUrl,
    },
    select: REDIRECT_LINK_SELECT,
  });
}

/**
 * コードから飛び先を引く（`/go/<code>` が使う）。
 *
 * **認証が無い入口。** 読者はログインしていない。**`userId` を取らない**
 * 代わりに、返すのは飛び先とリンクIDだけで、案件や記事の内容は返さない。
 *
 * @returns 見つからなければ `null`
 */
/**
 * ブログの中でコードを引く（D-12）。
 *
 * **`blogId` を必ず条件に入れる。** 受信APIはトークンでブログを決めており、
 * **他ブログのコードを混ぜて送られても取り違えない**ようにする
 * （そのブログのクリック数を外から水増しできてしまう）。
 *
 * `userId` を取らないのは `findRedirectTargetByCode` と同じ — 送信元は
 * 各ブログのWordPressで、セッションが無い。
 */
export async function findLinkByCodeInBlog(params: {
  blogId: string;
  code: string;
}): Promise<{ id: string; destinationUrl: string } | null> {
  if (!isRedirectCode(params.code)) {
    return null;
  }

  return prisma.affiliateLink.findFirst({
    where: { code: params.code, blogId: params.blogId },
    select: { id: true, destinationUrl: true },
  });
}

export async function findRedirectTargetByCode(code: string): Promise<{
  linkId: string;
  destinationUrl: string;
} | null> {
  // DBを引く前に形で弾く（総当たりの負荷を落とす）
  if (!isRedirectCode(code)) {
    return null;
  }

  const row = await prisma.affiliateLink.findUnique({
    where: { code },
    select: { id: true, destinationUrl: true },
  });

  return row === null
    ? null
    : { linkId: row.id, destinationUrl: row.destinationUrl };
}
