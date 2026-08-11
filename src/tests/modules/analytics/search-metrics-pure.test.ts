import { describe, expect, it } from 'vitest';
import {
  LOOKBACK_DAYS,
  fetchWindow,
  normalizePageUrl,
  shiftDate,
} from '@/modules/analytics';

/**
 * 取得の期間とURLの突き合わせ（TASKS G-2）。
 *
 * **昨日ぶんだけ取らない。** Search Console のデータは遅れて確定するため、
 * 直近数日を毎回取り直す。取りこぼしたまま二度と取り直さないのを防ぐ。
 */

describe('fetchWindow', () => {
  /** JST 2026-08-11（火）の 08:00。UTCでは前日 23:00 */
  const NOW = new Date('2026-08-10T23:00:00.000Z');

  it('終端は今日（JST）', () => {
    expect(fetchWindow(NOW).endDate).toBe('2026-08-11');
  });

  it('さかのぼる日数ぶんの幅を持つ', () => {
    const window = fetchWindow(NOW);

    expect(window.startDate).toBe('2026-08-07');
    expect(
      (Date.parse(window.endDate) - Date.parse(window.startDate)) / 86_400_000,
    ).toBe(LOOKBACK_DAYS - 1);
  });

  /** **確定していない日も含めて取り直す。** 次の実行で上書きされる */
  it('遅れて確定する日を含む', () => {
    expect(LOOKBACK_DAYS).toBeGreaterThanOrEqual(3);
  });
});

describe('shiftDate', () => {
  it('日数だけ戻す', () => {
    expect(shiftDate('2026-08-11', 4)).toBe('2026-08-07');
  });

  it('月をまたいで戻せる', () => {
    expect(shiftDate('2026-08-02', 4)).toBe('2026-07-29');
  });

  it('年をまたいで戻せる', () => {
    expect(shiftDate('2026-01-02', 4)).toBe('2025-12-29');
  });

  it('0なら同じ日', () => {
    expect(shiftDate('2026-08-11', 0)).toBe('2026-08-11');
  });
});

/**
 * **末尾の `/` と大文字小文字で取り逃さない。**
 * WordPress のパーマリンクは末尾に `/` が付き、Search Console が返すURLと
 * 食い違うことがある。揃えないと**記事があるのに0件として並ぶ。**
 */
describe('normalizePageUrl', () => {
  it('末尾のスラッシュの有無を揃える', () => {
    expect(normalizePageUrl('https://example.com/post/')).toBe(
      normalizePageUrl('https://example.com/post'),
    );
  });

  it('ホストの大文字小文字を揃える', () => {
    expect(normalizePageUrl('https://Example.COM/post')).toBe(
      normalizePageUrl('https://example.com/post'),
    );
  });

  /** **パスの大文字小文字は揃えない。** 別のページでありうる */
  it('パスの大文字小文字は残す', () => {
    expect(normalizePageUrl('https://example.com/Post')).not.toBe(
      normalizePageUrl('https://example.com/post'),
    );
  });

  it('スキームが違えば別のURL', () => {
    expect(normalizePageUrl('http://example.com/post')).not.toBe(
      normalizePageUrl('https://example.com/post'),
    );
  });

  it('URLとして読めなければそのまま揃える', () => {
    expect(normalizePageUrl('  ヘンな値  ')).toBe('ヘンな値');
  });
});
