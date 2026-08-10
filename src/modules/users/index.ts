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
  recordConsent,
  type UsersDb,
  type UsersDeps,
} from './repository';

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
