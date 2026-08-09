import { describe, expect, it } from 'vitest';
import {
  MASK_CHARACTER,
  MASK_LENGTH,
  SETTING_ERROR_CODES,
  maskSecret,
  normalizeSettingValue,
} from '@/modules/settings';

/** 値の検証と伏せ字（TASKS H-7）。DBを触らない純粋な処理 */

describe('値の検証', () => {
  it('前後の空白を落とす', () => {
    expect(normalizeSettingValue('MAIL_FROM', '  a@example.com  ')).toBe(
      'a@example.com',
    );
  });

  it.each([
    ['AI_PROVIDER', 'gemini'],
    ['AI_PRICE_STANDARD_INPUT', '-1'],
    ['AI_PRICE_STANDARD_INPUT', '0'],
    ['AI_PRICE_STANDARD_INPUT', 'たかい'],
    ['AI_BUDGET_STOP_ON_EXCEEDED', 'yes'],
    ['AI_BUDGET_STOP_ON_EXCEEDED', 'TRUE'],
    ['MAIL_FROM', 'not-an-address'],
    ['ANTHROPIC_API_KEY', 'short'],
    ['AI_MODEL_STANDARD', '   '],
  ])('%s に %s は入れられない', (key, value) => {
    expect(() => normalizeSettingValue(key, value)).toThrowError(
      expect.objectContaining({ code: SETTING_ERROR_CODES.invalidValue }),
    );
  });

  it.each([
    ['AI_PROVIDER', 'anthropic'],
    ['AI_PRICE_STANDARD_INPUT', '3'],
    ['AI_PRICE_STANDARD_INPUT', '0.25'],
    ['AI_BUDGET_STOP_ON_EXCEEDED', 'false'],
    ['MAIL_FROM', 'noreply@example.com'],
    ['ANTHROPIC_API_KEY', 'sk-ant-0123456789'],
  ])('%s に %s は入れられる', (key, value) => {
    expect(normalizeSettingValue(key, value)).toBe(value);
  });

  it('一覧にない名前は 404', () => {
    expect(() => normalizeSettingValue('DATABASE_URL', 'x')).toThrowError(
      expect.objectContaining({
        code: SETTING_ERROR_CODES.unknownKey,
        status: 404,
      }),
    );
  });

  /**
   * **入力値をエラーメッセージへ入れない。** 秘密の設定も同じ経路を通るため、
   * 入れるとAPIキーがそのまま外へ出る。
   */
  it('失敗しても入力値をメッセージに含めない', () => {
    const error: unknown = (() => {
      try {
        // 短すぎて弾かれる。それでも値そのものは外へ出してはいけない
        normalizeSettingValue('ANTHROPIC_API_KEY', 'sk-mine');
        return null;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect((error as { message: string }).message).not.toContain('sk-mine');
  });

  it('文字列でない値を受け付けない', () => {
    expect(() => normalizeSettingValue('MAIL_FROM', 42)).toThrowError(
      expect.objectContaining({ code: SETTING_ERROR_CODES.invalidValue }),
    );
  });
});

describe('伏せ字', () => {
  it('末尾4文字だけ残す', () => {
    expect(maskSecret('sk-ant-api03-ABCDEFGH')).toBe(
      `${MASK_CHARACTER.repeat(MASK_LENGTH)}EFGH`,
    );
  });

  /** 実際の長さを伝えない（短い鍵だと総当たりの手がかりになる） */
  it('伏せ字の長さは元の長さに依らない', () => {
    const short = maskSecret('sk-0123456789012');
    const long = maskSecret('sk-0123456789012345678901234567890123456789');

    expect(short.length).toBe(long.length);
  });

  /** 8文字の値の末尾4文字を出すと半分が分かってしまう */
  it('短い値は末尾を見せない', () => {
    expect(maskSecret('abcdefgh')).toBe(MASK_CHARACTER.repeat(MASK_LENGTH));
    expect(maskSecret('')).toBe(MASK_CHARACTER.repeat(MASK_LENGTH));
  });
});
