/**
 * `/api/personas` をブラウザから呼ぶ（D-14）。
 *
 * **サーバー側の型を借りない。** JSON を通ると `Date` は文字列になる。
 * 借りると、画面で `createdAt.getTime()` のような実行時に落ちるコードが
 * 型検査を通ってしまう（`blogs-api.ts` と同じ方針）。
 *
 * セッションは Cookie（B-2）。同一オリジンへの `fetch` は既定で送る。
 */

export type PersonaType = 'SELF' | 'IDEAL' | 'CHARACTER';
export type PersonaStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type EmojiLevel = 'none' | 'low' | 'mid';
export type LineBreakStyle = 'short' | 'normal';
export type KnowledgeLevel = 'beginner' | 'intermediate' | 'advanced';

export interface PersonaIdentityJson {
  name: string;
  firstPerson: string;
  background: string;
  tone: {
    style: string;
    emojiLevel: EmojiLevel;
    lineBreak: LineBreakStyle;
    politeness: string;
  };
  values: { priorities: string[]; avoid: string[] };
  ngExpressions: string[];
}

export interface PersonaExpertiseJson {
  fields: string[];
  sources: string[];
  evaluationCriteria: string[];
}

export interface PersonaAudienceJson {
  ageRange: string;
  situation: string;
  knowledgeLevel: KnowledgeLevel;
  problems: string[];
  searchIntents: string[];
}

export interface PersonaBusinessJson {
  revenuePolicy: string;
  monthlyGoalYen: number;
  kpis: string[];
  exitCriteria: string;
}

export interface PersonaJson {
  id: string;
  name: string;
  personaType: PersonaType;
  identity: PersonaIdentityJson;
  expertise: PersonaExpertiseJson;
  audience: PersonaAudienceJson;
  business: PersonaBusinessJson;
  status: PersonaStatus;
}

/**
 * いま何体まで使えるか。
 *
 * **「上限です」だけを画面に出さないための内訳**（D-14）。待てば開くのか、
 * 止めれば開くのか、そもそも開かないのかを、この値から書き分ける。
 */
export interface PersonaLimitsJson {
  max: number;
  active: number;
  allowedNow: number;
  joinedDays: number | null;
  nextUnlockInDays: number | null;
}

export interface PersonaListJson {
  personas: PersonaJson[];
  limits: PersonaLimitsJson;
}

/** 作成・更新で送る形。`status` は送らない（`/status` が担う） */
export interface PersonaInput {
  name: string;
  personaType: PersonaType;
  identity: PersonaIdentityJson;
  expertise: PersonaExpertiseJson;
  audience: PersonaAudienceJson;
  business: PersonaBusinessJson;
}

/** 画面に出せる失敗。原因を推測せず、サーバーの文言をそのまま使う */
export class PersonaApiError extends Error {
  override readonly name = 'PersonaApiError';
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
    throw new PersonaApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new PersonaApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as T;
}

function json(method: string, input: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  };
}

export function fetchPersonas(): Promise<PersonaListJson> {
  return request<PersonaListJson>('/api/personas');
}

export function fetchPersona(personaId: string): Promise<{
  persona: PersonaJson;
}> {
  return request<{ persona: PersonaJson }>(
    `/api/personas/${encodeURIComponent(personaId)}`,
  );
}

export function createPersona(
  input: PersonaInput,
): Promise<{ persona: PersonaJson }> {
  return request<{ persona: PersonaJson }>(
    '/api/personas',
    json('POST', input),
  );
}

export function savePersona(
  personaId: string,
  input: PersonaInput,
): Promise<{ persona: PersonaJson }> {
  return request<{ persona: PersonaJson }>(
    `/api/personas/${encodeURIComponent(personaId)}`,
    json('PATCH', input),
  );
}

export function changePersonaStatus(
  personaId: string,
  action: 'ACTIVATE' | 'PAUSE',
): Promise<{ persona: PersonaJson; limits: PersonaLimitsJson }> {
  return request<{ persona: PersonaJson; limits: PersonaLimitsJson }>(
    `/api/personas/${encodeURIComponent(personaId)}/status`,
    json('POST', { action }),
  );
}
