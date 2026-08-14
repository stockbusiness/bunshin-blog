/**
 * `/api/blogs/:blogId/offers` をブラウザから呼ぶ（段8・I-3）。
 *
 * **`AppAffiliateOffer` をそのまま使わない。** JSON を通ると `Date` は
 * 文字列になる（`blogs-api.ts` と同じ理由）。
 *
 * **モニターが決めない項目は型にも入れない**（Q-001・Q-014・Q-019）。
 * `linkMode` `subIdParam` `blogPostingProhibited` は ASP の規約に関わる
 * 判断で、**入口が受け取らない。** 送れる形にしておくと、いつか送られる。
 */

export type ConversionType =
  'FREE_SIGNUP' | 'REQUEST' | 'TRIAL' | 'PURCHASE' | 'OTHER';

export type UserExperience = 'USED' | 'NOT_USED' | 'UNKNOWN';

export type OfferStatus =
  'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'NEEDS_REVIEW';

export interface OfferJson {
  id: string;
  blogId: string;
  name: string;
  aspName: string;
  advertiserName: string | null;
  landingPageUrl: string;
  affiliateUrl: string;
  rewardYen: number | null;
  conversionType: ConversionType;
  userExperience: UserExperience;
  userRating: number | null;
  denyConditions: string[];
  status: OfferStatus;
  /** ISO 8601。切れていると分かった最初の時刻（H-3b）。直っていれば `null` */
  linkBrokenAt: string | null;
}

/**
 * 登録で送れる項目。
 *
 * **必須は5つ**（`name` `aspName` `landingPageUrl` `affiliateUrl`
 * `conversionType`）。残りは省いてよい。
 */
export interface CreateOfferInput {
  name: string;
  aspName: string;
  landingPageUrl: string;
  affiliateUrl: string;
  conversionType: ConversionType;
  rewardYen?: number;
  userExperience?: UserExperience;
  denyConditions?: string[];
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class OfferApiError extends Error {
  override readonly name = 'OfferApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NETWORK_MESSAGE = '通信に失敗しました。電波の良い場所でお試しください';
const UNEXPECTED_MESSAGE = '処理できませんでした。時間をおいてお試しください';

interface ErrorBody {
  error?: { message?: string };
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    throw new OfferApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new OfferApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as T;
}

function base(blogId: string): string {
  return `/api/blogs/${encodeURIComponent(blogId)}/offers`;
}

export function fetchOffers(blogId: string): Promise<{ offers: OfferJson[] }> {
  return request(base(blogId));
}

export function createOffer(
  blogId: string,
  input: CreateOfferInput,
): Promise<{ offer: OfferJson }> {
  return request(base(blogId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
