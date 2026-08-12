/**
 * line モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * LINE への通知を行うのはこのモジュールだけ。本タスク（F-2）で
 * 実装したのは提案の送信のみ。件数制御は F-3、返信の受け口は D-7。
 *
 * **`approvals` の行は `approvals` モジュールを通して触る**（MODULE_RULES 1）。
 */

export {
  sendPendingProposalsForUser,
  sendEmergencyNotificationForUser,
  remainingSlotsForUser,
  enqueueAlertsForUser,
  type SendProposalsDeps,
  type SendProposalsResult,
  type EmergencyKind,
} from './notify';

export {
  dailyNotificationLimit,
  remainingNotificationSlots,
  DEFAULT_DAILY_PROPOSAL_LIMIT,
  MAX_DAILY_PROPOSAL_LIMIT,
} from './limit';

export {
  buildProposalMessages,
  buildApprovalUrl,
  truncate,
  type ProposalNotification,
} from './message';

export {
  LINE_ERROR_CODES,
  lineNotConfiguredError,
  notificationTargetMissingError,
  type LineErrorCode,
} from './errors';

export {
  collectAlertsForUser,
  judgeConnectionAlert,
  alertIdempotencyKey,
  type BlogAlert,
  type CollectAlertsDeps,
} from './alerts';

export {
  NOTIFICATION_WINDOW_MINUTES,
  UNSENT_PROPOSAL_TTL_DAYS,
  isWithinNotificationWindow,
  type NotificationSchedule,
} from './schedule';
