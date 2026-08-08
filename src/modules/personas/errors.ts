import { AppError } from '@/lib/errors';

/** personas モジュールのエラーコード（TASKS D-4） */
export const PERSONA_ERROR_CODES = {
  /** 入力の形式が受け付けられない */
  invalidPersona: 'PERSONA_INVALID',
  /** まだ人格が登録されていない */
  notFound: 'PERSONA_NOT_FOUND',
} as const;

export type PersonaErrorCode =
  (typeof PERSONA_ERROR_CODES)[keyof typeof PERSONA_ERROR_CODES];

/** 入力の不備を表す。**理由を返す**（直しようがなくなるため） */
export function invalidPersonaError(reason: string): AppError {
  return new AppError(
    PERSONA_ERROR_CODES.invalidPersona,
    422,
    `分身の設定を確認してください：${reason}`,
  );
}

/**
 * 人格が未登録であることを表す。
 *
 * **404 を返す。** 他人の人格を引こうとした場合と同じ見え方にする
 * （`user_personas` は `user_id` で一意なので、そもそも他人のものは引けない）。
 */
export function personaNotFoundError(): AppError {
  return new AppError(
    PERSONA_ERROR_CODES.notFound,
    404,
    '分身の設定がまだ登録されていません',
  );
}
