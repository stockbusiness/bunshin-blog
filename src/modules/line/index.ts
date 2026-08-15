/**
 * line モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * LINE への通知を行うのはこのモジュールだけ。送信は F-2、件数制御は F-3、
 * 返信の分類は D-7a、返信の取り込みは D-7b。
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
  RICH_MENU_ERROR_CODES,
  lineNotConfiguredError,
  notificationTargetMissingError,
  richMenuError,
  type LineErrorCode,
  type RichMenuErrorCode,
} from './errors';

export {
  EMPTY_RICH_MENU,
  RICH_MENU_DESTINATIONS,
  buildLiffUrl,
  retargetAreasToLiffBase,
  applyRichMenu,
  createConfiguredRichMenuClient,
  describeRichMenuState,
  readRichMenu,
  readRichMenuImage,
  removeRemoteRichMenu,
  saveRichMenu,
  saveRichMenuImage,
  validateRichMenu,
  type AppliedRichMenu,
  type ApplyRichMenuDeps,
  type RichMenuAreaInput,
  type RichMenuDestination,
  type RichMenuInput,
  type RichMenuState,
  type StoredRichMenu,
} from './rich-menu';

export {
  collectAlertsForUser,
  judgeConnectionAlert,
  alertIdempotencyKey,
  type BlogAlert,
  type CollectAlertsDeps,
} from './alerts';

export {
  parseLineWebhook,
  REPLY_TEXT_MAX_LENGTH,
  type LineTextReply,
  type ParsedWebhook,
} from './webhook-payload';

export {
  recordLineReplyForUser,
  type ReplyOutcome,
  type ReplyIntakeResult,
  type ReplyIntakeDeps,
} from './reply-intake';

export {
  REPLY_KINDS,
  classifyLineReply,
  type ReplyKind,
  type ReplyClassification,
} from './reply-classification';

export { enqueueLinkCheckForUser } from './notify';

export {
  NOTIFICATION_WINDOW_MINUTES,
  UNSENT_PROPOSAL_TTL_DAYS,
  isWithinNotificationWindow,
  type NotificationSchedule,
} from './schedule';
