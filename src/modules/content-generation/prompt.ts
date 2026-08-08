/**
 * プロンプトの版の検証（TASKS E-2、SPEC 6.2）。
 *
 * DBを触らない純粋な処理。
 */

import { invalidPromptError } from './errors';
import type { CreatePromptVersionInput } from './types';

export const PROMPT_KEY_MAX_LENGTH = 80;
export const PROMPT_VERSION_MAX_LENGTH = 40;
export const PROMPT_BODY_MAX_LENGTH = 50_000;
export const PROMPT_NOTES_MAX_LENGTH = 500;

/**
 * `key` に使える文字。
 *
 * **`article.body` のような区切り付きの名前を想定する。** 空白や記号を
 * 許すと、コード側が文字列で引くときに揺れる。
 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/;

/**
 * `version` に使える文字。
 *
 * `v1` `v2.1` `2026-08-08` のいずれも通す。**並び順を決めない** —
 * 「どれが新しいか」は `created_at` で見る（版の文字列から順序を
 * 推測すると、`v10` が `v9` より前に来る）。
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw invalidPromptError(`${label}を文字列で入力してください`);
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw invalidPromptError(`${label}が空です`);
  }

  if (trimmed.length > max) {
    throw invalidPromptError(`${label}は${max}文字以内で入力してください`);
  }

  return trimmed;
}

export function normalizePromptKey(value: string): string {
  const key = assertText(value, 'プロンプトの種類', PROMPT_KEY_MAX_LENGTH);

  if (!KEY_PATTERN.test(key)) {
    throw invalidPromptError(
      'プロンプトの種類は英小文字・数字・ドットで指定してください（例: article.body）',
    );
  }

  return key;
}

export function normalizePromptVersion(value: string): string {
  const version = assertText(value, '版', PROMPT_VERSION_MAX_LENGTH);

  if (!VERSION_PATTERN.test(version)) {
    throw invalidPromptError(
      '版は英数字と . _ - で指定してください（例: v1、2026-08-08）',
    );
  }

  return version;
}

export interface NormalizedPromptVersion {
  key: string;
  version: string;
  body: string;
  notes: string | null;
}

/**
 * 本文を整える。
 *
 * **前後の空白だけ落とし、中身は変えない。** 改行やインデントは
 * プロンプトの意味に関わる。
 */
export function normalizeCreatePromptVersion(
  input: CreatePromptVersionInput,
): NormalizedPromptVersion {
  return {
    key: normalizePromptKey(input.key),
    version: normalizePromptVersion(input.version),
    body: assertText(input.body, '本文', PROMPT_BODY_MAX_LENGTH),
    notes:
      input.notes === undefined || input.notes.trim() === ''
        ? null
        : assertText(input.notes, 'メモ', PROMPT_NOTES_MAX_LENGTH),
  };
}
