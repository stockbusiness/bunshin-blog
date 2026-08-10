import { AppError } from '@/lib/errors';

/** approvals モジュールのエラーコード（TASKS F-5） */
export const APPROVAL_ERROR_CODES = {
  /** 自分の承認ではない、または無い */
  notFound: 'APPROVAL_NOT_FOUND',
  /** 既に別の答えを出している */
  alreadyDecided: 'APPROVAL_ALREADY_DECIDED',
  /** 修正依頼の入力が受け付けられない */
  invalidRevision: 'APPROVAL_INVALID_REVISION',
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

/**
 * 既に別の答えを出していることを表す。
 *
 * **承認した提案を見送りへ変えさせない。** 変えられると、
 * 何を承認したのかが分からなくなる。同じ答えなら成功する（冪等）ため、
 * ここへ来るのは**違う答え**のときだけ。
 */
export function approvalAlreadyDecidedError(current: string): AppError {
  return new AppError(
    APPROVAL_ERROR_CODES.alreadyDecided,
    409,
    `この提案には既に回答済みです（${current}）`,
  );
}

/** 修正依頼の入力が受け付けられないことを表す */
export function invalidRevisionRequestError(reason: string): AppError {
  return new AppError(APPROVAL_ERROR_CODES.invalidRevision, 422, reason);
}
