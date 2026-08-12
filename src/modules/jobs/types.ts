/**
 * ジョブ基盤の型（TASKS E-1、SPEC 4.3）。
 *
 * **`jobs` モジュールはドメインモジュールを import しない**（MODULE_RULES 3）。
 * ハンドラの登録は `src/app/` 側で行う。ここには「ジョブとは何か」だけを置く。
 */

export type JobStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/**
 * ジョブの種類（SPEC 4.3）。
 *
 * **文字列で持つ**（DBの列も `text`）。enum にすると、種類を増やすたびに
 * マイグレーションが要る。値の一覧はここで固定する。
 */
export const JOB_TYPES = [
  'BLOG_ANALYSIS',
  'PLAN_GENERATION',
  'ARTICLE_GENERATION',
  'ARTICLE_REGENERATION',
  'WORDPRESS_POST',
  'WORDPRESS_SYNC',
  'SEARCH_CONSOLE_FETCH',
  // **インデックス状況は別ジョブ**（TASKS G-3、SPEC 11.3）。
  // 呼び出しの上限の枠が Search Analytics と別で、記事の本数だけ呼ぶ。
  // 同じジョブにすると、上限に当たったときに検索データまで巻き戻る
  'URL_INSPECTION',
  // **日次集計は外部に依存しない**（TASKS G-6）。Google が落ちていても数えられる
  'METRICS_AGGREGATE',
  'GA4_FETCH',
  'PROPOSAL_SELECTION',
  // **1日1回の積み込み**（I-1）。日次のジョブをここから配る
  'DAILY_SCHEDULE',
  'LINE_NOTIFY',
  // **LINE返信の取り込みはジョブに載せる**（D-7b、MODULE_RULES 3）。
  // Webhook のハンドラで直接処理すると、保存に時間がかかったときに
  // LINE 側が時間切れと見なして**同じ電文を再送**する
  'LINE_REPLY',
  'LINK_CHECK',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

/** ジョブの外向け表現 */
export interface AppJob {
  id: string;
  jobType: string;
  userId: string | null;
  blogId: string | null;
  targetId: string | null;
  status: JobStatus;
  attemptCount: number;
  idempotencyKey: string;
  input: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 投入の入力。
 *
 * **`idempotencyKey` は呼び出し側が決める**（SPEC 7.3「`content_item_id`
 * ごとの冪等性キー」）。同じキーで2回投入しても行は増えない。
 */
export interface EnqueueJobInput {
  jobType: JobType;
  idempotencyKey: string;
  input: unknown;
  userId?: string | undefined;
  blogId?: string | undefined;
  targetId?: string | undefined;
}

export interface EnqueueResult {
  job: AppJob;
  /** 新規に積んだなら `true`、既にあったなら `false` */
  created: boolean;
}

/**
 * ジョブの処理。
 *
 * 戻り値は `output_json` に保存する。例外を投げると失敗として記録され、
 * 上限まで再試行される。
 */
export type JobHandler = (job: AppJob) => Promise<unknown>;

/** 種類ごとのハンドラ。登録は `src/app/` 側（MODULE_RULES 3） */
export type JobHandlerRegistry = Readonly<Partial<Record<JobType, JobHandler>>>;
