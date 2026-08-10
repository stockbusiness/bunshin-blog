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
  type RefreshProposalsDeps,
  type RefreshProposalsResult,
} from './propose';

export { listApprovalsForUser, type AppApproval } from './repository';

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
