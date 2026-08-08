import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  AI_ERROR_CODES,
  AI_OPERATIONS,
  MODEL_TIERS,
  estimateCostUsd,
  operationsForTier,
  resolveApiKey,
  resolveModel,
  resolveProvider,
  tierForOperation,
} from '@/lib/ai';

/**
 * モデルの決定と料金（TASKS E-3、SPEC 9.8）。
 *
 * 完了条件は「**モデル名が環境変数・設定テーブル経由で切替可能**」。
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'NOT_APP_ERROR';
  }

  return 'NO_THROW';
}

describe('resolveProvider', () => {
  it('未設定なら anthropic', () => {
    expect(resolveProvider({ env: {} })).toBe('anthropic');
  });

  it.each([['anthropic'], ['openai']])('%s を通す', (value) => {
    expect(resolveProvider({ env: { AI_PROVIDER: value } })).toBe(value);
  });

  it('知らないプロバイダーを拒否する', () => {
    expect(
      codeOf(() => resolveProvider({ env: { AI_PROVIDER: 'gemini' } })),
    ).toBe(AI_ERROR_CODES.notConfigured);
  });
});

describe('resolveModel（完了条件）', () => {
  it('未設定なら既定のモデルを使う', () => {
    const resolved = resolveModel('STANDARD', { env: {} });

    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).not.toBe('');
  });

  /** **これが完了条件そのもの** */
  it.each([
    ['LOW', 'AI_MODEL_LOW'],
    ['STANDARD', 'AI_MODEL_STANDARD'],
    ['HIGH', 'AI_MODEL_HIGH'],
  ] as const)('%s は %s で差し替えられる', (tier, key) => {
    expect(resolveModel(tier, { env: { [key]: 'custom-model' } }).model).toBe(
      'custom-model',
    );
  });

  it('段ごとに別のモデルになる', () => {
    const env = {};
    const models = MODEL_TIERS.map((tier) => resolveModel(tier, { env }).model);

    // 低コストと高性能が同じでは、段を分けた意味が無い
    expect(models[0]).not.toBe(models[2]);
  });

  it('プロバイダーを変えると既定も変わる', () => {
    expect(
      resolveModel('LOW', { env: { AI_PROVIDER: 'openai' } }).model,
    ).not.toBe(
      resolveModel('LOW', { env: { AI_PROVIDER: 'anthropic' } }).model,
    );
  });

  it('空文字は未設定として扱う', () => {
    expect(resolveModel('LOW', { env: { AI_MODEL_LOW: '   ' } }).model).toBe(
      resolveModel('LOW', { env: {} }).model,
    );
  });
});

describe('料金', () => {
  it('両方そろっていれば読む', () => {
    const resolved = resolveModel('LOW', {
      env: { AI_PRICE_LOW_INPUT: '1.5', AI_PRICE_LOW_OUTPUT: '7.5' },
    });

    expect(resolved.pricing).toEqual({
      inputPerMillion: 1.5,
      outputPerMillion: 7.5,
    });
  });

  /**
   * **片方だけの単価で計算しない。** 費用が実際より小さく出て、
   * 予算通知（E-15）が鳴らない。
   */
  it.each([
    [{ AI_PRICE_LOW_INPUT: '1.5' }],
    [{ AI_PRICE_LOW_OUTPUT: '7.5' }],
    [{}],
  ])('片方だけ・未設定なら null（%o）', (env) => {
    expect(resolveModel('LOW', { env }).pricing).toBeNull();
  });

  it.each([['-1'], ['abc'], ['NaN']])('不正な単価 %o を拒否する', (value) => {
    expect(
      codeOf(() =>
        resolveModel('LOW', {
          env: { AI_PRICE_LOW_INPUT: value, AI_PRICE_LOW_OUTPUT: '1' },
        }),
      ),
    ).toBe(AI_ERROR_CODES.notConfigured);
  });
});

describe('estimateCostUsd', () => {
  const pricing = { inputPerMillion: 3, outputPerMillion: 15 };

  it('トークン数から費用を出す', () => {
    expect(
      estimateCostUsd({ pricing, inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(3);
    expect(
      estimateCostUsd({ pricing, inputTokens: 0, outputTokens: 1_000_000 }),
    ).toBeCloseTo(15);
    expect(
      estimateCostUsd({ pricing, inputTokens: 500_000, outputTokens: 100_000 }),
    ).toBeCloseTo(1.5 + 1.5);
  });

  /** **0で埋めない。** 費用が計上されないまま予算を使い切る */
  it('単価が無ければ null', () => {
    expect(
      estimateCostUsd({ pricing: null, inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull();
  });
});

describe('resolveApiKey', () => {
  it('設定されていれば返す', () => {
    expect(
      resolveApiKey('anthropic', { env: { ANTHROPIC_API_KEY: 'sk-test' } }),
    ).toBe('sk-test');
  });

  it('無ければ落とす', () => {
    expect(codeOf(() => resolveApiKey('anthropic', { env: {} }))).toBe(
      AI_ERROR_CODES.notConfigured,
    );
  });

  /** **値をメッセージへ入れない**（SPEC 14.2） */
  it('メッセージに変数名だけを出す', () => {
    try {
      resolveApiKey('openai', { env: {} });
    } catch (error) {
      expect((error as AppError).message).toContain('OPENAI_API_KEY');
      expect((error as AppError).message).not.toContain('sk-');
    }
  });
});

describe('モデルルーティング（SPEC 9.8）', () => {
  it('全ての場面に段が付いている', () => {
    for (const operation of AI_OPERATIONS) {
      expect(MODEL_TIERS).toContain(tierForOperation(operation));
    }
  });

  it.each([
    ['CLASSIFY', 'LOW'],
    ['SUMMARIZE', 'LOW'],
    ['NOTIFICATION_TEXT', 'LOW'],
    ['KEYWORD_DEDUP', 'LOW'],
    ['FACT_CLAIM_EXTRACT', 'LOW'],
    ['ARTICLE_BODY', 'STANDARD'],
    ['ARTICLE_REWRITE', 'STANDARD'],
    ['INTERNAL_LINK', 'STANDARD'],
    ['CTA', 'STANDARD'],
    ['PRIORITY_ARTICLE', 'HIGH'],
    ['QUALITY_RECHECK', 'HIGH'],
    ['COMPARISON', 'HIGH'],
    ['MONTHLY_STRATEGY', 'HIGH'],
  ] as const)('%s は %s', (operation, tier) => {
    expect(tierForOperation(operation)).toBe(tier);
  });

  it('段ごとに場面が引ける', () => {
    expect(operationsForTier('STANDARD')).toContain('ARTICLE_BODY');
    expect(operationsForTier('STANDARD')).not.toContain('CLASSIFY');
  });

  // 記事本文が高性能モデルに落ちると、費用の見積もりが崩れる
  it('段の割り当てに漏れが無い', () => {
    const covered = MODEL_TIERS.flatMap((tier) => operationsForTier(tier));

    expect(covered.sort()).toEqual([...AI_OPERATIONS].sort());
  });
});
