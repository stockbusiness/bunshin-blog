/**
 * `/api/approvals` をブラウザから呼ぶ（F-4）。
 *
 * **サーバー側の型を借りない。** JSON を通ると `Date` は文字列になる。
 * 借りると、画面で `sentAt.getTime()` のような実行時に落ちるコードが
 * 型検査を通ってしまう（`blogs-api.ts` と同じ理由）。
 *
 * セッションは Cookie（B-2）。同一オリジンへの `fetch` は既定で送るため、
 * ここでトークンを持ち回らない。
 */

import { readApiErrorMessage } from '@/lib/api-error';

export interface ApprovalJson {
  id: string;
  blogId: string;
  blogName: string;
  articleTitle: string;
  status: string;
  proposalType: string;
  proposalReason: string;
  factCheckStatus: string;
  riskFlagCount: number;
  /** ISO8601 の文字列。`Date` ではない */
  sentAt: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface ApprovalListJson {
  approvals: ApprovalJson[];
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class ApprovalApiError extends Error {
  override readonly name = 'ApprovalApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readError(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);

  throw new ApprovalApiError(
    response.status,
    readApiErrorMessage(body, '読み込めませんでした'),
  );
}

export async function fetchApprovals(): Promise<ApprovalListJson> {
  const response = await fetch('/api/approvals', {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    await readError(response);
  }

  return (await response.json()) as ApprovalListJson;
}

/** 未確認の主張（E-12）。**形は Q-023 で未解決** */
export interface UnverifiedClaimJson {
  text?: string;
  type?: string;
  excerpt?: string;
  reason?: string;
}

/** リスクフラグ（E-13、DATA_MODEL 132） */
export interface RiskFlagJson {
  code?: string;
  severity?: string;
  message?: string;
  excerpt?: string;
}

export interface ApprovalDetailJson {
  approval: {
    id: string;
    blogId: string;
    blogName: string;
    status: string;
    proposalType: string;
    proposalReason: string;
  };
  article: {
    versionNo: number;
    title: string;
    excerpt: string;
    answerCapsule: string;
    bodyHtml: string;
    faq: { question: string; answer: string }[];
    factCheckStatus: string;
    unverifiedClaims: UnverifiedClaimJson[];
    riskFlags: RiskFlagJson[];
  };
  generation: {
    modelProvider: string;
    modelName: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: string;
    createdAt: string;
  };
  offer: { name: string; affiliateUrl: string } | null;
  banners: { id: string; name: string; imageUrl: string; slot: string }[];
}

export async function fetchApprovalDetail(
  approvalId: string,
): Promise<ApprovalDetailJson> {
  const response = await fetch(
    `/api/approvals/${encodeURIComponent(approvalId)}`,
    { headers: { accept: 'application/json' } },
  );

  if (!response.ok) {
    await readError(response);
  }

  return (await response.json()) as ApprovalDetailJson;
}

/** 修正依頼の種類（SPEC 5.15）。**画面に出す順で並べる** */
export const REVISION_CHOICES = [
  { value: 'SHORTER', label: '短くしてほしい' },
  { value: 'SOFTER', label: '表現をやわらげてほしい' },
  { value: 'CHANGE_TITLE', label: 'タイトルを変えてほしい' },
  { value: 'CHANGE_PRODUCT', label: '案件を変えてほしい' },
  { value: 'FACT_ERROR', label: '事実に誤りがある' },
  { value: 'FREE_TEXT', label: 'その他（自由記述）' },
] as const;

export type RevisionChoice = (typeof REVISION_CHOICES)[number]['value'];

async function post(path: string, body?: unknown): Promise<{ status: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    await readError(response);
  }

  return (await response.json()) as { status: string };
}

function base(approvalId: string): string {
  return `/api/approvals/${encodeURIComponent(approvalId)}`;
}

/** 開いたことを記録する。**読み取りとは別**（SPEC 13.6） */
export async function markApprovalViewed(
  approvalId: string,
): Promise<{ status: string }> {
  return post(`${base(approvalId)}/view`);
}

export async function approveApproval(
  approvalId: string,
): Promise<{ status: string }> {
  return post(`${base(approvalId)}/approve`);
}

export async function skipApproval(
  approvalId: string,
): Promise<{ status: string }> {
  return post(`${base(approvalId)}/skip`);
}

export async function requestRevision(
  approvalId: string,
  input: { requestType: RevisionChoice; comment?: string },
): Promise<{ status: string }> {
  return post(`${base(approvalId)}/revision`, input);
}
