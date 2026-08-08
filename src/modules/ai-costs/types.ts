/**
 * ai-costs モジュールの型（TASKS E-14、SPEC 12.1・12.2）。
 */

import type { AiOperation, AiProviderName } from '@/lib/ai';

/** 1回のAI呼び出しの記録（`ai_usage_logs`） */
export interface AppAiUsageLog {
  id: string;
  userId: string;
  /** ブログに紐づかない呼び出し（月次戦略分析など）は `null` */
  blogId: string | null;
  /** 記事に紐づかない呼び出しは `null` */
  contentItemId: string | null;
  /** どのジョブから呼んだか。同期呼び出しなら `null` */
  jobId: string | null;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  /** USD。**単価が未設定でも記録は残す**（0で入る） */
  costUsd: number;
  createdAt: Date;
}

export interface RecordAiUsageInput {
  userId: string;
  blogId?: string | null | undefined;
  contentItemId?: string | null | undefined;
  jobId?: string | null | undefined;
  provider: AiProviderName | string;
  model: string;
  operation: AiOperation | string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls?: number | undefined;
  /** `null` は「単価が未設定で計算できなかった」を表す */
  costUsd?: number | null | undefined;
}

/** 集計の切り口（完了条件「ユーザー別・ブログ別・記事別・モデル別」） */
export interface AiCostSummary {
  /** 何で束ねたか（`userId` `blogId` `contentItemId` `model` のいずれかの値） */
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** 単価が未設定で費用を計算できなかった呼び出しの数 */
  unpricedCalls: number;
}

/** 集計の期間。JSTの暦日で指定する（DATA_MODEL 10章） */
export interface CostPeriod {
  from: Date;
  to: Date;
}
