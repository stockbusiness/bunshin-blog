/**
 * `/api/onboarding` をブラウザから呼ぶ（H-2a）。
 *
 * **サーバー側の型を借りない**（`blogs-api.ts` と同じ方針）。
 */

export type OnboardingStep =
  | 'LINE_LOGIN'
  | 'TERMS'
  | 'DATA_CONSENT'
  | 'PERSONA'
  | 'BLOG'
  | 'WORDPRESS'
  | 'GENRE'
  | 'OFFER'
  | 'NOTIFICATION'
  | 'SNIPPET';

export interface OnboardingStepJson {
  step: OnboardingStep;
  done: boolean;
  current: boolean;
}

export interface OnboardingProgressJson {
  steps: OnboardingStepJson[];
  currentStep: OnboardingStep | null;
  completed: boolean;
  doneCount: number;
  totalCount: number;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
}

export class OnboardingApiError extends Error {
  override readonly name = 'OnboardingApiError';
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

export async function fetchOnboarding(): Promise<OnboardingProgressJson> {
  let response: Response;

  try {
    response = await fetch('/api/onboarding');
  } catch {
    throw new OnboardingApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new OnboardingApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return (body as { progress: OnboardingProgressJson }).progress;
}

export interface NotificationScheduleJson {
  /** `0` が日曜（`Date.getDay()` と揃える） */
  days: number[];
  /** `HH:MM`（JSTの壁掛け時計） */
  time: string;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch {
    throw new OnboardingApiError(0, NETWORK_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const message = (body as ErrorBody | undefined)?.error?.message;
    throw new OnboardingApiError(
      response.status,
      message === undefined || message === '' ? UNEXPECTED_MESSAGE : message,
    );
  }

  return body as T;
}

export function acceptConsent(
  kind: 'TERMS' | 'DATA_USE',
): Promise<{ consents: { terms: boolean; dataUse: boolean } }> {
  return request('/api/onboarding/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  });
}

export function fetchNotificationSchedule(): Promise<{
  schedule: NotificationScheduleJson | null;
}> {
  return request('/api/onboarding/notification');
}

export function saveNotificationSchedule(
  schedule: NotificationScheduleJson,
): Promise<{ schedule: NotificationScheduleJson }> {
  return request('/api/onboarding/notification', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(schedule),
  });
}
