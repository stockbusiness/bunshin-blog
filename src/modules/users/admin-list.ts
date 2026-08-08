import { prisma } from '@/lib/db';
import type { AppUser } from './types';

/**
 * 管理画面向けのモニター一覧（B-7、SPEC 6.2 `/admin/users`）。
 *
 * **ADMIN 専用。`requireAdmin` を通した後でのみ呼ぶ**（MODULE_RULES 5）。
 * 名前に `ForAdmin` を付けているのは、呼び出し側を見ただけで
 * 「これは全ユーザーを横断して読む」と分かるようにするため。
 *
 * `users` と `monitor_profiles` はどちらも users モジュールの所有テーブル
 * （MODULE_RULES）。結合はここで行う。
 */

export type OnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export interface AdminMonitorSummary {
  id: string;
  displayName: string;
  email: string | null;
  status: AppUser['status'];
  /** `monitor_profiles` が未作成なら `null`（オンボーディング未開始） */
  onboardingStatus: OnboardingStatus | null;
  termsAcceptedAt: Date | null;
  dataUseConsentAt: Date | null;
  createdAt: Date;
}

/**
 * モニターを登録順に並べて返す。
 *
 * **`role = 'MONITOR'` のみ。** SPEC 6.2 の画面は「モニター一覧」であり、
 * 運営者自身を混ぜると実験の参加者数が読めなくなる。
 *
 * **`WITHDRAWN` も含める。** 退会者を消すと「10名中何名が続いたか」が
 * 分からなくなる（SPEC 1.2 の目的）。状態は列で示す。
 */
export async function listMonitorsForAdmin(): Promise<AdminMonitorSummary[]> {
  const records = await prisma.user.findMany({
    where: { role: 'MONITOR' },
    select: {
      id: true,
      displayName: true,
      email: true,
      status: true,
      termsAcceptedAt: true,
      dataUseConsentAt: true,
      createdAt: true,
      monitorProfile: { select: { onboardingStatus: true } },
    },
    // `created_at` はミリ秒までしか持たない。同じミリ秒に作られると
    // 前後が決まらないので、`id` を最後の決め手にして並びを固定する
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return records.map((record) => ({
    id: record.id,
    displayName: record.displayName,
    email: record.email,
    status: record.status as AppUser['status'],
    onboardingStatus:
      record.monitorProfile === null
        ? null
        : (record.monitorProfile.onboardingStatus as OnboardingStatus),
    termsAcceptedAt: record.termsAcceptedAt,
    dataUseConsentAt: record.dataUseConsentAt,
    createdAt: record.createdAt,
  }));
}
