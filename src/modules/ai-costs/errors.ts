import { AppError } from '@/lib/errors';

/** ai-costs モジュールのエラーコード（TASKS E-14） */
export const AI_COST_ERROR_CODES = {
  /** 記録の内容が不正 */
  invalidUsage: 'AI_COST_INVALID_USAGE',
} as const;

export type AiCostErrorCode =
  (typeof AI_COST_ERROR_CODES)[keyof typeof AI_COST_ERROR_CODES];

/**
 * 記録の不備を表す。
 *
 * **呼び出し側の誤り。** トークン数や費用は人の入力ではなく、AI呼び出しの
 * 結果から作る値なので、ここへ来るのは組み立ての間違い。
 */
export function invalidUsageError(reason: string): AppError {
  return new AppError(
    AI_COST_ERROR_CODES.invalidUsage,
    500,
    `AI利用記録を作れません：${reason}`,
  );
}
