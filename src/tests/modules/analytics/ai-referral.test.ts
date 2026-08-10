import { describe, expect, it } from 'vitest';
import {
  AI_REFERRAL_DOMAINS,
  isAiReferralHost,
  matchesDomain,
  resolveAiReferralDomains,
} from '@/modules/analytics';

/**
 * AI検索流入の判別（TASKS G-4、SPEC 11.4）。
 *
 * 完了条件は「**対象ドメインが設定ファイルで追加できる**」。
 *
 * **完全な数にならない。** `Referer` は付かないことがあり、
 * 取れなかったものは「AI経由でない」に倒している（SPEC 11.4）。
 */

describe('ドメインの一致', () => {
  it('完全一致で通す', () => {
    expect(matchesDomain('chatgpt.com', 'chatgpt.com')).toBe(true);
  });

  it('サブドメインを通す', () => {
    expect(matchesDomain('www.chatgpt.com', 'chatgpt.com')).toBe(true);
    expect(matchesDomain('jp.www.chatgpt.com', 'chatgpt.com')).toBe(true);
  });

  /**
   * **単純な `endsWith` にしない。** `notchatgpt.com` が
   * `chatgpt.com` に一致してしまう
   */
  it('紛らわしいドメインを通さない', () => {
    expect(matchesDomain('notchatgpt.com', 'chatgpt.com')).toBe(false);
    expect(matchesDomain('chatgpt.com.evil.example', 'chatgpt.com')).toBe(
      false,
    );
  });

  it('大小文字と末尾のドットを吸収する', () => {
    expect(matchesDomain('WWW.ChatGPT.com.', 'chatgpt.com')).toBe(true);
  });
});

describe('AI検索経由かどうか', () => {
  it.each([
    ['chatgpt.com'],
    ['www.perplexity.ai'],
    ['gemini.google.com'],
    ['copilot.microsoft.com'],
  ])('%s は AI 経由', (host) => {
    expect(isAiReferralHost(host)).toBe(true);
  });

  it.each([['google.com'], ['t.co'], ['example.com']])(
    '%s は AI 経由でない',
    (host) => {
      expect(isAiReferralHost(host)).toBe(false);
    },
  );

  /**
   * **`Referer` の欠落は異常ではない**（SPEC 11.4）。
   * 「AI経由だと判別できなかった」だけ
   */
  it.each([[null], [undefined], ['']])('%o は false', (host) => {
    expect(isAiReferralHost(host)).toBe(false);
  });

  /** **`gemini.google.com` は AI、`google.com` は違う** */
  it('同じ親ドメインでも区別する', () => {
    expect(isAiReferralHost('gemini.google.com')).toBe(true);
    expect(isAiReferralHost('www.google.com')).toBe(false);
  });
});

describe('対象ドメインを設定で足せる（完了条件）', () => {
  it('環境変数の値が足される', () => {
    const domains = resolveAiReferralDomains({
      AI_REFERRAL_EXTRA_DOMAINS: 'newai.example, another.example',
    });

    expect(isAiReferralHost('www.newai.example', domains)).toBe(true);
    expect(isAiReferralHost('another.example', domains)).toBe(true);
  });

  /** **消せない。足すだけ。** 空にされると判別が全て false になる */
  it('既定を上書きできない', () => {
    const domains = resolveAiReferralDomains({
      AI_REFERRAL_EXTRA_DOMAINS: '',
    });

    expect(domains).toEqual(expect.arrayContaining([...AI_REFERRAL_DOMAINS]));
    expect(isAiReferralHost('chatgpt.com', domains)).toBe(true);
  });

  it('未設定でも既定が効く', () => {
    expect(isAiReferralHost('chatgpt.com', resolveAiReferralDomains({}))).toBe(
      true,
    );
  });

  it('空白と重複を落とす', () => {
    const domains = resolveAiReferralDomains({
      AI_REFERRAL_EXTRA_DOMAINS: ' chatgpt.com , , newai.example ',
    });

    expect(domains.filter((domain) => domain === 'chatgpt.com')).toHaveLength(
      1,
    );
    expect(domains).toContain('newai.example');
  });
});
