import type { AlternativeGenre, GenreReviewText } from './ai';
import type { Step1Decision, Step1Judgement } from './step1';

/** `planning_runs` の1行（外へ出す形） */
export interface AppPlanningRun {
  id: string;
  blogId: string;
  step1Status: Step1Decision | 'OVERRIDDEN';
  reasons: string[];
  rejectionCount: number;
  /** 「リスクを理解して進める」を選んだ時刻。選んでいなければ `null` */
  overriddenAt: Date | null;
  createdAt: Date;
}

/** ジャンル審査の結果（画面とジョブへ返す形） */
export interface GenreReviewResult {
  run: AppPlanningRun;
  judgement: Step1Judgement;
  /**
   * 利用者向けの説明。**AIが作る。判定には関わらない。**
   * 呼べなかったときは `null`（判定は残す）
   */
  text: GenreReviewText | null;
  /**
   * 別ジャンルの候補。`BLOCKED` のときだけ入る。
   * `HIGH` と既に停止したジャンルは除いてある
   */
  alternatives: AlternativeGenre[];
  /**
   * 「リスクを理解して進める」を出せるか（SPEC 9.2.2）。
   * 差し戻し2回のあとに `true` になる
   */
  canOverride: boolean;
}
