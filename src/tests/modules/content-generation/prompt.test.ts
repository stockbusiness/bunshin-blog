import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  PROMPT_BODY_MAX_LENGTH,
  PROMPT_ERROR_CODES,
  PROMPT_KEY_MAX_LENGTH,
  normalizeCreatePromptVersion,
  normalizePromptKey,
  normalizePromptVersion,
} from '@/modules/content-generation';

/** プロンプトの版の検証（TASKS E-2、SPEC 6.2） */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('normalizePromptKey', () => {
  it.each([['article'], ['article.body'], ['article.faq.v2'], ['plan1.step2']])(
    '%s を通す',
    (key) => {
      expect(normalizePromptKey(key)).toBe(key);
    },
  );

  /** コード側が文字列で引くため、揺れる形を許さない */
  it.each([
    ['Article.body'],
    ['article body'],
    ['article_body'],
    ['.article'],
    ['article.'],
    ['1article'],
    [''],
  ])('%o を拒否する', (key) => {
    expect(codeOf(() => normalizePromptKey(key))).toBe(
      PROMPT_ERROR_CODES.invalidPrompt,
    );
  });

  it('長すぎる種類を拒否する', () => {
    expect(
      codeOf(() => normalizePromptKey('a'.repeat(PROMPT_KEY_MAX_LENGTH + 1))),
    ).toBe(PROMPT_ERROR_CODES.invalidPrompt);
  });

  // 何を入れればよいか分からないと直しようがない
  it('例をメッセージに含める', () => {
    try {
      normalizePromptKey('Article Body');
    } catch (error) {
      expect((error as AppError).message).toContain('article.body');
    }
  });
});

describe('normalizePromptVersion', () => {
  it.each([['v1'], ['v2.1'], ['2026-08-08'], ['rc_3']])(
    '%s を通す',
    (version) => {
      expect(normalizePromptVersion(version)).toBe(version);
    },
  );

  it.each([['v 1'], ['v/1'], ['.v1'], ['']])('%o を拒否する', (version) => {
    expect(codeOf(() => normalizePromptVersion(version))).toBe(
      PROMPT_ERROR_CODES.invalidPrompt,
    );
  });
});

describe('normalizeCreatePromptVersion', () => {
  const input = {
    key: 'article.body',
    version: 'v1',
    body: '  あなたは編集者です。\n  丁寧に書いてください。  ',
  };

  /** 改行やインデントはプロンプトの意味に関わる */
  it('本文の中身を変えない', () => {
    expect(normalizeCreatePromptVersion(input).body).toBe(
      'あなたは編集者です。\n  丁寧に書いてください。',
    );
  });

  it('メモが無ければ null', () => {
    expect(normalizeCreatePromptVersion(input).notes).toBeNull();
  });

  it('空白だけのメモも null', () => {
    expect(
      normalizeCreatePromptVersion({ ...input, notes: '   ' }).notes,
    ).toBeNull();
  });

  it.each([[''], ['   ']])('本文 %o を拒否する', (body) => {
    expect(codeOf(() => normalizeCreatePromptVersion({ ...input, body }))).toBe(
      PROMPT_ERROR_CODES.invalidPrompt,
    );
  });

  it('長すぎる本文を拒否する', () => {
    expect(
      codeOf(() =>
        normalizeCreatePromptVersion({
          ...input,
          body: 'あ'.repeat(PROMPT_BODY_MAX_LENGTH + 1),
        }),
      ),
    ).toBe(PROMPT_ERROR_CODES.invalidPrompt);
  });
});
