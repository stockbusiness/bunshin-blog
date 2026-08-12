/**
 * users モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `users` テーブルを触ってよいのはこのモジュールだけ。
 */

export {
  findByLineUserId,
  findById,
  findAdminByEmail,
  findOrCreateByLineUserId,
  findNotificationTargetForUser,
  findMaxDailyProposalsForUser,
  findNotificationScheduleForUser,
  acceptConsentForUser,
  saveNotificationScheduleForUser,
  syncOnboardingStatusForUser,
  recordConsent,
  type UsersDb,
  type UsersDeps,
} from './repository';

export {
  withdrawMonitorForAdmin,
  exportUserDataForAdmin,
  WITHDRAWAL_ERROR_CODES,
  type WithdrawResult,
  type UserDataExport,
} from './withdrawal';

export {
  updateMonitorStatusForAdmin,
  canApplyMonitorAction,
  isMonitorAdminAction,
  USER_ADMIN_ERROR_CODES,
  type MonitorAdminAction,
  type UserAdminErrorCode,
} from './admin-status';

export {
  listMonitorsForAdmin,
  type AdminMonitorSummary,
  type OnboardingStatus,
} from './admin-list';

export {
  hasAllConsents,
  missingConsents,
  isActiveUser,
  CONSENT_KINDS,
  type AppUser,
  type ConsentKind,
} from './types';

export {
  ONBOARDING_STEPS,
  resolveOnboardingProgress,
  type OnboardingStep,
  type OnboardingStepState,
  type OnboardingFacts,
  type OnboardingProgress,
} from './onboarding';

export {
  NOTIFICATION_DAY_MIN,
  NOTIFICATION_DAY_MAX,
  normalizeNotificationSchedule,
  toNotificationTimeColumn,
  fromNotificationTimeColumn,
  type NotificationSchedule,
} from './notification-schedule';
