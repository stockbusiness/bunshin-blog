/**
 * approvals モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `approvals` `revision_requests` を触ってよいのはこのモジュールだけ。
 * 本タスク（F-1）で実装したのは `approvals` の作成と一覧のみ。
 *
 * **IDだけで引く関数を公開しない**（SPEC 14.1）。
 */

export {
  refreshProposalsForUser,
  enqueueProposalSelectionForUser,
  type RefreshProposalsDeps,
  type RefreshProposalsResult,
} from './propose';

export {
  listApprovalsForUser,
  listUnsentApprovalsForUser,
  expireStaleUnsentApprovalsForUser,
  claimUnsentApprovalForUser,
  countProposalsSentInRangeForUser,
  listApprovalSummariesForUser,
  findApprovalForUser,
  type AppApproval,
  type UnsentApproval,
  type ApprovalSummary,
  type FoundApproval,
} from './repository';

export {
  rankProposals,
  scoreCandidate,
  buildProposalReason,
  publishOrderPoints,
  waitingPoints,
  openProposalPenalty,
  riskPenalty,
  NEVER_PROPOSED_POINTS,
  type ProposalCandidate,
  type BlogProposalState,
  type ScoredProposal,
} from './priority';

export { readApprovalDetailForUser, type ApprovalDetail } from './detail';

export {
  APPROVAL_ERROR_CODES,
  approvalNotFoundError,
  approvalAlreadyDecidedError,
  invalidRevisionRequestError,
  type ApprovalErrorCode,
} from './errors';

export {
  markViewedForUser,
  approveForUser,
  skipForUser,
  requestRevisionForUser,
  listRevisionRequestsForUser,
  isRevisionRequestType,
  REVISION_REQUEST_TYPES,
  REVISION_COMMENT_MAX_LENGTH,
  type RevisionRequestType,
  type DecideInput,
  type RevisionInput,
} from './decide';

export { countApprovalActivityForAdmin } from './repository';

export {
  judgeApprovalActivity,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_LABELS,
  MIN_SENT_FOR_JUDGEMENT,
  LOW_RESPONSE_RATE,
  type ActivityVerdict,
  type ActivityCounts,
  type ActivityJudgement,
} from './activity';
