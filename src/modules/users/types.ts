/**
 * users モジュールが外部へ渡すユーザー表現（B-2）。
 *
 * Prisma の型をそのまま外へ出さない。ORM の都合が他モジュールへ漏れると、
 * スキーマ変更のたびに全モジュールが影響を受ける。
 */
export interface AppUser {
  id: string;
  role: 'ADMIN' | 'MONITOR';
  displayName: string;
  status: 'INVITED' | 'ACTIVE' | 'PAUSED' | 'WITHDRAWN';
  /** 利用規約への同意時刻。未同意なら null */
  termsAcceptedAt: Date | null;
  /** データ利用への同意時刻。未同意なら null */
  dataUseConsentAt: Date | null;
}

/** 同意の種類（SPEC 6.1 のオンボーディング 2・3 に対応） */
export const CONSENT_KINDS = ['terms', 'dataUse'] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * 同意が全て揃っているか。
 *
 * **利用規約とデータ利用の両方が必要。** どちらか一方では足りない
 * （SPEC 6.1、TASKS B-2「同意なしで他APIが403」）。
 */
export function hasAllConsents(user: AppUser): boolean {
  return user.termsAcceptedAt !== null && user.dataUseConsentAt !== null;
}

/** 揃っていない同意の一覧を返す。UIの誘導に使う */
export function missingConsents(user: AppUser): ConsentKind[] {
  const missing: ConsentKind[] = [];
  if (user.termsAcceptedAt === null) {
    missing.push('terms');
  }
  if (user.dataUseConsentAt === null) {
    missing.push('dataUse');
  }
  return missing;
}

/**
 * APIを利用できる状態か。
 *
 * 同意が揃っていても、停止・退会したユーザーは利用できない（SPEC 13.2）。
 */
export function isActiveUser(user: AppUser): boolean {
  return user.status === 'ACTIVE';
}
