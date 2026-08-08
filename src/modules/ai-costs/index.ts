/**
 * ai-costs モジュールの公開インターフェース（MODULE_RULES 2）。
 *
 * `ai_usage_logs` を触ってよいのはこのモジュールだけ。
 *
 * **費用の合計は所有権を伴う経路でしか出さない**（SPEC 14.1）。
 * 横断は `...ForAdmin`（MODULE_RULES 5）。
 */

export {
  recordAiUsage,
  summarizeCostForUser,
  totalCostForUser,
  totalBlogCostForUser,
  totalContentItemCostForUser,
  listAiUsageForUser,
  summarizeByUserForAdmin,
  findAiUsageForAdmin,
  notifyBudgetCrossings,
  recordAiUsageAndNotify,
} from './repository';

export {
  crossedThresholds,
  readBudgetLimits,
  shouldStopGeneration,
  shouldDowngradeModel,
  buildBudgetAlert,
  BUDGET_THRESHOLDS,
  type BudgetCrossing,
  type BudgetLimits,
  type BudgetScope,
  type BudgetThreshold,
} from './budget';

export {
  AI_COST_ERROR_CODES,
  invalidUsageError,
  type AiCostErrorCode,
} from './errors';

export type {
  AppAiUsageLog,
  RecordAiUsageInput,
  AiCostSummary,
  CostPeriod,
} from './types';
