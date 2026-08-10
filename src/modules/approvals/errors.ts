import { AppError } from '@/lib/errors';

/** approvals モジュールのエラーコード（TASKS F-5） */
export const APPROVAL_ERROR_CODES = {
  /** 自分の承認ではない、または無い */
  notFound: 'APPROVAL_NOT_FOUND',
} as const;

export type ApprovalErrorCode =
  (typeof APPROVAL_ERROR_CODES)[keyof typeof APPROVAL_ERROR_CODES];

/**
 * 承認が見つからないことを表す。
 *
 * **「他人のもの」と「無い」を区別しない。** 区別すると、IDを変えながら
 * 叩くだけで「そのIDは存在する」と分かってしまう（SPEC 14.1）。
 */
export function approvalNotFoundError(): AppError {
  return new AppError(
    APPROVAL_ERROR_CODES.notFound,
    404,
    '提案が見つかりません',
  );
}
