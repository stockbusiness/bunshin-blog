/**
 * 運営が用意する案件の元（Q-055、段8）。
 *
 * ## なぜ要るか
 *
 * **「案件を決めるのが大変」**と実地で言われた（2026-08-16）。
 * 30ブログが同じ案件を別々に調べるより、**運営が1回調べて配る**ほうが
 * 正確で速い。E-6 は記事数を「案件数×2＋1」で決めるので、
 * **案件が増えないと記事も増えない。**
 *
 * ## AIに案件を考えさせない
 *
 * 候補を出すのはAIだが、**AIが選べるのはここに在るものだけ**
 * （`proposal.ts`）。案件そのものをAIに考えさせると、
 * **存在しない商品名やありもしない報酬額**が入り、それが
 * `facts` を通って記事の数値になる（SPEC 9.6）。
 *
 * ## 事実の出どころを1つにする
 *
 * 同じ商品が複数ブログにあると、**片方だけ古い価格が残り、
 * それが「確かめ済み」として記事に出る。** ここを元にして、
 * 古いままのブログへ「確かめてください」と出す
 * （`listOffersNeedingFactCheckForUser`）。**勝手に書き換えない** —
 * 確かめるのは人（D-13・Q-022）。
 *
 * ## `facts_updated_at` は `facts` を変えたときだけ
 *
 * `affiliate_offers` と同じ規律（D-13）。**状態を変えただけで
 * 「確かめ直した」ことにしない。**
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { requireBlogForUser } from '@/modules/blogs';
import type { ConversionType, LinkMode } from './types';

export const OFFER_CATALOG_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ENDED',
] as const;

export type OfferCatalogStatus = (typeof OFFER_CATALOG_STATUSES)[number];

/** `types.ts` の `LinkMode` を画面の選択肢に使うための並び */
export const LINK_MODES: readonly LinkMode[] = ['DIRECT', 'REDIRECT'];

export interface OfferCatalogItem {
  id: string;
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  /** 1行に1つ（Q-050）。**運営が確かめたもの** */
  facts: string[];
  /** **NULL は「一度も確かめていない」**（D-13 と同じ扱い） */
  factsUpdatedAt: Date | null;
  denyConditions: string[];
  linkMode: LinkMode;
  subIdParam: string | null;
  blogPostingProhibited: boolean;
  lpFormFields: number | null;
  lpMobileReady: boolean | null;
  /** どんなブログに向くか、という運営の見立て。**AIの提案が読む** */
  genreHints: string[];
  notes: string | null;
  status: OfferCatalogStatus;
  updatedAt: Date;
}

export interface CatalogItemInput {
  name: string;
  aspName: string;
  advertiserName?: string | null;
  landingPageUrl: string;
  rewardYen?: number | null;
  conversionType: ConversionType;
  facts: readonly string[];
  denyConditions?: readonly string[];
  linkMode?: LinkMode;
  subIdParam?: string | null;
  blogPostingProhibited?: boolean;
  lpFormFields?: number | null;
  lpMobileReady?: boolean | null;
  genreHints?: readonly string[];
  notes?: string | null;
  status?: OfferCatalogStatus;
}

const SELECT = {
  id: true,
  name: true,
  aspName: true,
  advertiserName: true,
  landingPageUrl: true,
  rewardYen: true,
  conversionType: true,
  facts: true,
  factsUpdatedAt: true,
  denyConditions: true,
  linkMode: true,
  subIdParam: true,
  blogPostingProhibited: true,
  lpFormFields: true,
  lpMobileReady: true,
  genreHints: true,
  notes: true,
  status: true,
  updatedAt: true,
} satisfies Prisma.OfferCatalogItemSelect;

type Row = Prisma.OfferCatalogItemGetPayload<{ select: typeof SELECT }>;

function toItem(row: Row): OfferCatalogItem {
  return {
    id: row.id,
    name: row.name,
    aspName: row.aspName,
    advertiserName: row.advertiserName,
    landingPageUrl: row.landingPageUrl,
    rewardYen: row.rewardYen,
    conversionType: row.conversionType as ConversionType,
    facts: readFacts(row.facts),
    factsUpdatedAt: row.factsUpdatedAt,
    denyConditions: row.denyConditions,
    linkMode: row.linkMode as LinkMode,
    subIdParam: row.subIdParam,
    blogPostingProhibited: row.blogPostingProhibited,
    lpFormFields: row.lpFormFields,
    lpMobileReady: row.lpMobileReady,
    genreHints: row.genreHints,
    notes: row.notes,
    status: row.status as OfferCatalogStatus,
    updatedAt: row.updatedAt,
  };
}

/**
 * **読めない行は落とす**（`rich-menu` の `areas` と同じ）。
 * 形が変わっても画面が開かなくならないようにする。
 */
function readFacts(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** 運営が見る一覧。**下書きも終了したものも出す** */
export async function listCatalogForAdmin(): Promise<OfferCatalogItem[]> {
  const rows = await prisma.offerCatalogItem.findMany({
    select: SELECT,
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
  });

  return rows.map(toItem);
}

/**
 * モニターとAIに見せる一覧。
 *
 * **`ACTIVE` だけ。** 下書きは調べている途中で、事実が入っていない。
 * **掲載禁止のものは出さない**（SPEC 9.2.3 の足切り）— 出すと、
 * 選べてしまったあとで止めることになる。
 */
export async function listSelectableCatalog(): Promise<OfferCatalogItem[]> {
  const rows = await prisma.offerCatalogItem.findMany({
    where: { status: 'ACTIVE', blogPostingProhibited: false },
    select: SELECT,
    orderBy: { name: 'asc' },
  });

  return rows.map(toItem);
}

export async function readCatalogItem(
  id: string,
): Promise<OfferCatalogItem | null> {
  const row = await prisma.offerCatalogItem.findUnique({
    where: { id },
    select: SELECT,
  });

  return row === null ? null : toItem(row);
}

/**
 * 案件を足す。**ADMIN だけ**（呼び出し側で確かめる）。
 *
 * @throws {AppError} 同じ ASP・同じ紹介先が既にあるとき
 */
export async function createCatalogItemForAdmin(
  input: CatalogItemInput,
  adminUserId: string,
): Promise<OfferCatalogItem> {
  const facts = normalizeFacts(input.facts);

  try {
    const row = await prisma.offerCatalogItem.create({
      data: {
        ...toData(input, facts),
        // **`facts` が入って初めて「確かめた」**（D-13）
        factsUpdatedAt: facts.length > 0 ? new Date() : null,
        updatedByUserId: adminUserId,
      },
      select: SELECT,
    });

    return toItem(row);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw AppError.conflict(
        'この ASP と紹介先の組み合わせは、すでに登録されています',
      );
    }

    throw error;
  }
}

/**
 * 案件を直す。
 *
 * **`facts` を実際に変えたときだけ `facts_updated_at` を動かす**（D-13）。
 * 状態を変えただけで「確かめ直した」ことにしない —
 * すると、**古い価格が「今日確かめた」として記事に出る。**
 *
 * @throws {AppError} 見つからないとき
 */
export async function updateCatalogItemForAdmin(
  id: string,
  input: CatalogItemInput,
  adminUserId: string,
): Promise<OfferCatalogItem> {
  const current = await readCatalogItem(id);

  if (current === null) {
    throw AppError.notFound('案件が見つかりません');
  }

  const facts = normalizeFacts(input.facts);
  const changed = !sameFacts(current.facts, facts);

  try {
    const row = await prisma.offerCatalogItem.update({
      where: { id },
      data: {
        ...toData(input, facts),
        ...(changed
          ? { factsUpdatedAt: facts.length > 0 ? new Date() : null }
          : {}),
        updatedByUserId: adminUserId,
      },
      select: SELECT,
    });

    return toItem(row);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw AppError.conflict(
        'この ASP と紹介先の組み合わせは、すでに登録されています',
      );
    }

    throw error;
  }
}

function toData(
  input: CatalogItemInput,
  facts: string[],
): Omit<Prisma.OfferCatalogItemUncheckedCreateInput, 'id'> {
  return {
    name: input.name.trim(),
    aspName: input.aspName.trim(),
    advertiserName: input.advertiserName?.trim() ?? null,
    landingPageUrl: input.landingPageUrl.trim(),
    rewardYen: input.rewardYen ?? null,
    conversionType: input.conversionType,
    facts,
    denyConditions: [...(input.denyConditions ?? [])],
    linkMode: input.linkMode ?? 'DIRECT',
    subIdParam: input.subIdParam?.trim() ?? null,
    blogPostingProhibited: input.blogPostingProhibited ?? false,
    lpFormFields: input.lpFormFields ?? null,
    lpMobileReady: input.lpMobileReady ?? null,
    genreHints: [...(input.genreHints ?? [])],
    notes: input.notes?.trim() ?? null,
    status: input.status ?? 'DRAFT',
  };
}

/** 空行と重複を落とす（`offer-draft` と同じ理由） */
function normalizeFacts(facts: readonly string[]): string[] {
  return [...new Set(facts.map((fact) => fact.trim()).filter((f) => f !== ''))];
}

function sameFacts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((fact, index) => fact === b[index]);
}

/** 元の事実が新しくなった案件（Q-055） */
export interface OfferFactAlert {
  offerId: string;
  offerName: string;
  /** 元を確かめ直した時刻 */
  catalogFactsUpdatedAt: Date;
  /** このブログの案件を確かめた時刻。**NULL は一度も確かめていない** */
  offerFactsUpdatedAt: Date | null;
}

/**
 * 元の事実が新しくなっている案件を挙げる。
 *
 * ## なぜ要るか
 *
 * 同じ商品を2つのブログで使うと、案件の行は2つになる。
 * **片方だけ直すと、もう片方は古い価格のまま**で、
 * しかも `facts_updated_at` は入っているので**「確かめ済み」として通る。**
 * 記事に書ける数値は `facts` から取る（SPEC 9.6）ので、
 * **古い価格がそのまま公開される。**
 *
 * ## 書き換えない
 *
 * ここは**知らせるだけ。** 元の事実で上書きすると、
 * 「人が確かめた」という記録の意味が消える（D-13・Q-022）。
 */
export async function listOffersNeedingFactCheckForUser(params: {
  userId: string;
  blogId: string;
}): Promise<OfferFactAlert[]> {
  const blog = await requireBlogForUser(params);

  const rows = await prisma.affiliateOffer.findMany({
    where: {
      blogId: blog.id,
      catalogItemId: { not: null },
      catalogItem: { factsUpdatedAt: { not: null } },
    },
    select: {
      id: true,
      name: true,
      factsUpdatedAt: true,
      catalogItem: { select: { factsUpdatedAt: true } },
    },
  });

  const alerts: OfferFactAlert[] = [];

  for (const row of rows) {
    const catalogAt = row.catalogItem?.factsUpdatedAt;

    if (catalogAt === undefined || catalogAt === null) {
      continue;
    }

    // **一度も確かめていない場合も挙げる。** 元より古いのと同じ状態
    if (row.factsUpdatedAt !== null && row.factsUpdatedAt >= catalogAt) {
      continue;
    }

    alerts.push({
      offerId: row.id,
      offerName: row.name,
      catalogFactsUpdatedAt: catalogAt,
      offerFactsUpdatedAt: row.factsUpdatedAt,
    });
  }

  return alerts;
}
