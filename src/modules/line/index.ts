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
  DEFAULT_NOTIFICATION_LIMIT,
  type SendProposalsDeps,
  type SendProposalsResult,
} from './notify';

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
